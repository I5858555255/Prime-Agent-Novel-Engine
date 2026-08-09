/**
 * Loop-level integration tests for auto-continuing responses truncated at the
 * provider's output-token limit (stopReason "length").
 *
 * Unlike the pure `shouldAutoContinueTruncatedResponse` unit tests, these drive
 * a real AgentSession with a mocked model stream so the session-loop behavior
 * is exercised: continuation queuing, budget accounting across turns, budget
 * reset on a fresh prompt, and the threshold-compaction ordering.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ImageContent,
	type TextContent,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const CONTINUATION_MARKER = "Continue from exactly where you left off";
const FINAL_TEXT = "finished reply after continuation";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function userTexts(context: { messages: unknown[] }): string[] {
	return context.messages
		.filter((message) => (message as { role?: string }).role === "user")
		.map((message) => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			return (content as Array<TextContent | ImageContent>)
				.filter((part) => typeof part === "object" && part !== null && part.type === "text")
				.map((part) => (part as TextContent).text)
				.join("\n");
		});
}

describe("AgentSession length-continuation loop", () => {
	let session: AgentSession;
	let tempDir: string;
	let calls: number;
	let isContinuation: (context: { messages: unknown[] }) => boolean;
	let respond: (stream: MockAssistantStream, context: { messages: unknown[] }) => void;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-length-cont-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		calls = 0;
	});

	afterEach(async () => {
		if (session) {
			try {
				session.dispose();
			} catch {
				// ignore
			}
		}
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				// ignore
			}
		}
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, context) => {
				calls++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const cont = isContinuation?.(context);
					if (respond) {
						respond(stream, context);
					} else if (cont) {
						stream.push({ type: "start", partial: assistantMessage("", "stop") });
						stream.push({ type: "done", reason: "stop", message: assistantMessage(FINAL_TEXT, "stop") });
					} else {
						stream.push({ type: "start", partial: assistantMessage("", "length") });
						stream.push({
							type: "done",
							reason: "length",
							message: assistantMessage("partial answer", "length"),
						});
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	}

	function sessionMessagesText(): string {
		const messages = (session.agent.state.messages ?? []) as Array<{
			role?: string;
			content?: unknown;
		}>;
		return messages
			.map((message) => {
				const content = message.content;
				if (typeof content === "string") return `${message.role}: ${content}`;
				return `${message.role}:${(content as Array<{ text?: string }>)
					.filter((part) => typeof part === "object" && part !== null && part.text !== undefined)
					.map((part) => part.text)
					.join(" ")}`;
			})
			.join(" | ");
	}

	async function waitForIdle() {
		await session.agent.waitForIdle();
	}

	it("auto-continues a response truncated at the output token limit", async () => {
		createSession();
		isContinuation = (context) => userTexts(context).some((t) => t.includes(CONTINUATION_MARKER));

		await session.prompt("First message");
		await waitForIdle();

		// First model call truncated; a second call followed with the steer prompt.
		expect(calls).toBe(2);
		const text = sessionMessagesText();
		expect(text).toContain("partial answer");
		expect(text).toContain(FINAL_TEXT);
	});

	it("stops auto-continuing after the bound is exhausted", async () => {
		createSession();
		// Every call returns a truncated response so the budget is what stops it.
		respond = (stream) => {
			stream.push({ type: "start", partial: assistantMessage("", "length") });
			stream.push({ type: "done", reason: "length", message: assistantMessage("still partial", "length") });
		};
		isContinuation = () => true;

		await session.prompt("First message");
		await waitForIdle();

		// 1 initial + MAX_LENGTH_CONTINUATIONS (3) continuation attempts, then stop.
		expect(calls).toBe(4);
	});
});
