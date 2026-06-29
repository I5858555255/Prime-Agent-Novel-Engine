/**
 * Minimal opt-in A2A server.
 *
 * Serves this Prime Agent instance as an A2A agent: an Agent Card at
 * `/.well-known/agent-card.json` and a JSON-RPC endpoint at `/`. Each inbound
 * `message/send` becomes one task whose lifecycle is working -> artifact ->
 * completed, with the agent's reply as the artifact.
 *
 * The actual work is delegated to `runPrompt`, which the extension wires to the
 * live session (see agent-bridge.ts). Tests inject a stub `runPrompt`, so this
 * module never depends on a real model.
 */

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type {
	AgentCard,
	Artifact,
	Message,
	Part,
	Task,
	TaskArtifactUpdateEvent,
	TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
	type AgentExecutor,
	DefaultRequestHandler,
	type ExecutionEventBus,
	InMemoryTaskStore,
	type RequestContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import express from "express";

export type RunPrompt = (text: string, signal?: AbortSignal) => Promise<string>;

function partsToText(parts: Part[]): string {
	return parts
		.filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function agentMessage(text: string, taskId: string, contextId: string): Message {
	return {
		kind: "message",
		messageId: randomUUID(),
		role: "agent",
		parts: [{ kind: "text", text }],
		taskId,
		contextId,
	};
}

/** AgentExecutor that runs each inbound message as a single Prime Agent turn. */
class PrimeAgentExecutor implements AgentExecutor {
	/** taskId -> contextId, so cancelTask (which only receives taskId) can report the right context. */
	private readonly contexts = new Map<string, string>();

	constructor(private readonly runPrompt: RunPrompt) {}

	async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
		const { userMessage, taskId, contextId } = requestContext;
		const promptText = partsToText(userMessage.parts);
		this.contexts.set(taskId, contextId);

		const working: Task = {
			kind: "task",
			id: taskId,
			contextId,
			status: { state: "working", timestamp: new Date().toISOString() },
			history: [userMessage],
		};
		eventBus.publish(working);

		try {
			const replyText = (await this.runPrompt(promptText)) || "(empty response)";

			const artifact: Artifact = {
				artifactId: randomUUID(),
				name: "response",
				parts: [{ kind: "text", text: replyText }],
			};
			const artifactEvent: TaskArtifactUpdateEvent = {
				kind: "artifact-update",
				taskId,
				contextId,
				artifact,
				lastChunk: true,
			};
			eventBus.publish(artifactEvent);

			const completed: TaskStatusUpdateEvent = {
				kind: "status-update",
				taskId,
				contextId,
				final: true,
				status: {
					state: "completed",
					timestamp: new Date().toISOString(),
					message: agentMessage(replyText, taskId, contextId),
				},
			};
			eventBus.publish(completed);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const failed: TaskStatusUpdateEvent = {
				kind: "status-update",
				taskId,
				contextId,
				final: true,
				status: {
					state: "failed",
					timestamp: new Date().toISOString(),
					message: agentMessage(`Error: ${message}`, taskId, contextId),
				},
			};
			eventBus.publish(failed);
		} finally {
			this.contexts.delete(taskId);
			eventBus.finished();
		}
	}

	async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
		// v1 does not interrupt an in-flight turn; report cancellation and stop.
		const canceled: TaskStatusUpdateEvent = {
			kind: "status-update",
			taskId,
			contextId: this.contexts.get(taskId) ?? taskId,
			final: true,
			status: { state: "canceled", timestamp: new Date().toISOString() },
		};
		eventBus.publish(canceled);
		eventBus.finished();
	}
}

export interface CreateA2AServerOptions {
	card: AgentCard;
	host: string;
	port: number;
	runPrompt: RunPrompt;
}

export interface A2AServerHandle {
	readonly card: AgentCard;
	/** Start listening. Resolves with the actually-bound host/port (port may be ephemeral when 0). */
	start(): Promise<{ host: string; port: number }>;
	stop(): Promise<void>;
}

/** Build (but do not start) the A2A HTTP server. */
export function createA2AServer(options: CreateA2AServerOptions): A2AServerHandle {
	const requestHandler = new DefaultRequestHandler(
		options.card,
		new InMemoryTaskStore(),
		new PrimeAgentExecutor(options.runPrompt),
	);

	const app = express();
	app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
	app.use("/", jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

	let server: Server | undefined;

	return {
		card: options.card,
		start() {
			return new Promise((resolve, reject) => {
				const onError = (err: Error) => reject(err);
				server = app.listen(options.port, options.host, () => {
					server?.off("error", onError);
					const address = server?.address();
					const bound =
						address && typeof address === "object"
							? { host: options.host, port: address.port }
							: { host: options.host, port: options.port };
					resolve(bound);
				});
				server.once("error", onError);
			});
		},
		stop() {
			return new Promise((resolve, reject) => {
				if (!server) {
					resolve();
					return;
				}
				server.close((err) => (err ? reject(err) : resolve()));
				server = undefined;
			});
		},
	};
}
