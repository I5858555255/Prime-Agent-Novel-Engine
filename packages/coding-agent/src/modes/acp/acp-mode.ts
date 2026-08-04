import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { VERSION } from "../../config.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import { takeOverStdout } from "../../core/output-guard.js";
import { InProcessAgentConnection } from "../agent-connection/in-process-agent-connection.js";
import type { AgentConnection } from "../agent-connection/types.js";
import { latestAutonomousGateAttempt } from "../headless-completion.js";
import { acpUpdatesForSessionEvent } from "./acp-events.js";
import { primeAgentMeta } from "./acp-meta.js";
import { type AcpStopReason, acpStopReason } from "./acp-stop-reason.js";

/**
 * ACP (Agent Client Protocol) mode.
 *
 * prime-agent acts as an ACP agent over NDJSON on stdio, driving an
 * `AgentConnection` in-process. It deliberately does not shell out to RPC mode
 * and translate: prime-agent's differentiators (IPython-only tools, subagents,
 * autonomous gates) are visible as first-class events here, and a translating
 * adapter is exactly what flattens them away.
 *
 * Capabilities ACP has no native concept for travel in a reverse-domain
 * `_meta` envelope, which vanilla ACP clients ignore.
 */

export interface AcpModeOptions {
	/** Bind headless extensions once the connection is live (in-process mode). */
	bindHeadlessExtensions?: () => Promise<void>;
	/**
	 * Transport override. Defaults to NDJSON over stdio; tests supply an
	 * in-memory stream pair so the protocol runs without a subprocess.
	 */
	stream?: ReturnType<typeof acp.ndJsonStream>;
	/** Skip claiming stdout when the caller supplies its own transport. */
	ownStdout?: boolean;
}

interface AcpSessionEntry {
	abort: AbortController | undefined;
	unsubscribe: (() => void) | undefined;
}

/** Prompt content blocks are ACP-shaped; prime-agent takes a single string. */
function promptText(blocks: readonly unknown[]): string {
	return blocks
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: string; text?: string };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function autonomousMeta(status: AgentAutonomousStatus | undefined): Record<string, unknown> | undefined {
	if (!status?.enabled) return undefined;
	return primeAgentMeta({
		autonomous: {
			enabled: status.enabled,
			continuationsUsed: status.continuationsUsed,
			turnsUsed: status.turnsUsed,
			tokensUsed: status.tokensUsed,
			gateAttempt: latestAutonomousGateAttempt(status) || undefined,
			gateFailure: status.lastGateFailure?.exitText,
		},
	});
}

export async function runAcpMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	const connection = new InProcessAgentConnection(runtimeHost);
	return runAcpModeWithConnection(connection, {
		bindHeadlessExtensions: () => connection.bindHeadlessExtensions({}),
	});
}

export async function runAcpModeWithConnection(
	connection: AgentConnection,
	options: AcpModeOptions = {},
): Promise<never> {
	// ACP owns stdout: any stray write corrupts the JSON-RPC stream.
	if (options.ownStdout !== false && !options.stream) {
		takeOverStdout();
	}

	const sessions = new Map<string, AcpSessionEntry>();
	let bound = false;

	const stream =
		options.stream ??
		acp.ndJsonStream(
			Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
			Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
		);

	acp.agent({ name: "prime-agent" })
		.onRequest("initialize", async () => ({
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: true, embeddedContext: true },
			},
			agentInfo: { name: "prime-agent", title: "Prime Agent", version: VERSION },
			// Advertise prime-agent extras under a namespaced key: ACP reserves
			// every object root for future protocol fields.
			_meta: primeAgentMeta({}),
		}))
		.onRequest("session/new", async (ctx: any) => {
			if (!bound) {
				bound = true;
				await options.bindHeadlessExtensions?.();
			}
			const sessionId = randomUUID();
			const entry: AcpSessionEntry = { abort: undefined, unsubscribe: undefined };
			sessions.set(sessionId, entry);
			// Subscribe for the session lifetime, not per prompt turn: prime-agent
			// subagents are fire-and-forget and keep reporting after the spawning
			// turn ends, so a turn-scoped subscription would drop their updates.
			entry.unsubscribe = connection.subscribe((event) => {
				const notify = (update: Record<string, unknown>) =>
					void ctx.client.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => undefined);
				// Heartbeats and cron schedules are connection-level rather than
				// session events, but they drive the long-running work an ACP client
				// most needs to observe.
				if (event.type === "heartbeats_changed") {
					notify({ sessionUpdate: "session_info_update", _meta: primeAgentMeta({ heartbeatsChanged: true }) });
					return;
				}
				if (event.type !== "session_event") return;
				for (const update of acpUpdatesForSessionEvent(event.event)) {
					notify(update);
				}
			});
			return { sessionId };
		})
		.onRequest("session/prompt", async (ctx: any) => {
			const params = ctx.params as { sessionId: string; prompt: readonly unknown[] };
			const entry = sessions.get(params.sessionId);
			if (!entry) throw new Error(`Unknown ACP session: ${params.sessionId}`);

			const abort = new AbortController();
			entry.abort = abort;

			try {
				await connection.promptAndWait(promptText(params.prompt));
				// Autonomous gates continue inside this same prompt turn: the turn is
				// only over once the gate loop settles.
				const status = await connection.waitForHeadlessCompletion();
				const meta = autonomousMeta(status);
				if (meta) {
					await ctx.client
						.notify(acp.methods.client.session.update, {
							sessionId: params.sessionId,
							update: { sessionUpdate: "session_info_update", _meta: meta },
						})
						.catch(() => undefined);
				}
				return { stopReason: acpStopReason({ cancelled: abort.signal.aborted, autonomous: status }) };
			} catch (error) {
				// Cancellation is a normal ACP prompt outcome, not a JSON-RPC error.
				if (abort.signal.aborted) return { stopReason: "cancelled" satisfies AcpStopReason };
				throw error;
			} finally {
				entry.abort = undefined;
			}
		})
		.onNotification("session/cancel", async (ctx: any) => {
			const params = ctx.params as { sessionId: string };
			const entry = sessions.get(params.sessionId);
			entry?.abort?.abort();
			await connection.abort().catch(() => undefined);
		})
		.connect(stream);

	return new Promise<never>(() => {});
}
