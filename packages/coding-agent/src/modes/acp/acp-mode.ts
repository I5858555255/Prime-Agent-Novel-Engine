import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { VERSION } from "../../config.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { InProcessAgentConnection } from "../agent-connection/in-process-agent-connection.js";
import type { AgentConnection } from "../agent-connection/types.js";
import { latestAutonomousGateAttempt } from "../headless-completion.js";
import { type AcpEventMappingState, acpUpdatesForSessionEvent } from "./acp-events.js";
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

/**
 * ACP frames must reach real stdout.
 *
 * Startup calls `takeOverStdout()` for every non-interactive mode, which
 * redirects `process.stdout.write` to stderr so stray logging cannot corrupt a
 * machine-readable stream. Handing `process.stdout` to the SDK would therefore
 * publish the whole protocol on stderr; write through the raw escape hatch the
 * guard exposes, exactly as RPC mode does.
 */
function rawStdoutSink(): WritableStream<Uint8Array> {
	const decoder = new TextDecoder();
	return new WritableStream<Uint8Array>({
		write(chunk) {
			writeRawStdout(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
		},
	});
}

function normalizeWindowsDriveLetter(path: string): string {
	if (process.platform !== "win32" || !/^[A-Z]:/i.test(path)) return path;
	return path.slice(0, 1).toLowerCase() + path.slice(1);
}

function canonicalCwd(path: string): string {
	const resolved = resolve(path);
	let canonical: string;
	try {
		canonical = realpathSync(resolved);
	} catch {
		// Preserve the previous lexical comparison when a path is missing or inaccessible.
		canonical = resolved;
	}
	return normalizeWindowsDriveLetter(canonical);
}

function sameCwd(left: string, right: string): boolean {
	const canonicalLeft = canonicalCwd(left);
	const canonicalRight = canonicalCwd(right);
	if (canonicalLeft === canonicalRight) return true;

	try {
		const leftStat = statSync(canonicalLeft, { bigint: true });
		const rightStat = statSync(canonicalRight, { bigint: true });
		// Either half being zero makes the pair untrustworthy: Windows path-based
		// stat can report dev 0 with a real ino, and comparing ino alone would match
		// distinct directories on different volumes, since file IDs are volume-local.
		const leftIdentityMissing = leftStat.dev === 0n || leftStat.ino === 0n;
		const rightIdentityMissing = rightStat.dev === 0n || rightStat.ino === 0n;
		if (leftIdentityMissing || rightIdentityMissing) return false;
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

const ACP_SESSION_PAGE_SIZE = 50;

function sessionCursor(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64url");
}

function sessionCursorOffset(cursor: unknown): number {
	if (cursor === undefined) return 0;
	if (typeof cursor !== "string") throw new Error("Invalid session/list cursor");
	const decoded = Buffer.from(cursor, "base64url").toString("utf8");
	const offset = Number(decoded);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid session/list cursor");
	return offset;
}

function messageReplayUpdates(message: AgentMessage): Record<string, unknown>[] {
	const typed = message as AgentMessage & { content?: unknown };
	const sessionUpdate = message.role === "user" ? "user_message_chunk" : message.role === "assistant" ? "agent_message_chunk" : undefined;
	if (!sessionUpdate) return [];
	const blocks = typeof typed.content === "string" ? [{ type: "text", text: typed.content }] : Array.isArray(typed.content) ? typed.content : [];
	return blocks.flatMap((block) => {
		if (!block || typeof block !== "object") return [];
		const item = block as { type?: unknown; text?: unknown };
		if (item.type !== "text" || typeof item.text !== "string" || item.text.length === 0) return [];
		return [{ sessionUpdate, content: { type: "text", text: item.text } }];
	});
}

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
	id: string;
	abort: AbortController | undefined;
	unsubscribe: (() => void) | undefined;
}

/**
 * Split ACP prompt blocks into the text and images prime-agent accepts.
 */
function promptContent(blocks: readonly unknown[]): { text: string; images: ImageContent[] } {
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const typed = block as {
			type?: string;
			text?: string;
			data?: string;
			mimeType?: string;
			uri?: string;
			resource?: { text?: string; uri?: string };
		};
		if (typed.type === "text" && typeof typed.text === "string") {
			texts.push(typed.text);
		} else if (typed.type === "image" && typeof typed.data === "string" && typeof typed.mimeType === "string") {
			images.push({ type: "image", data: typed.data, mimeType: typed.mimeType });
		} else if (typed.type === "resource" && typeof typed.resource?.text === "string") {
			const uri = typed.resource.uri ? `${typed.resource.uri}\n` : "";
			texts.push(`${uri}${typed.resource.text}`);
		} else if (typed.type === "resource_link" && typeof typed.uri === "string") {
			texts.push(typed.uri);
		}
	}
	return { text: texts.join("\n"), images };
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

interface TurnBoundary {
	identities: WeakSet<object>;
	keys: Set<string>;
}

function messageKey(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as { role?: unknown; timestamp?: unknown; stopReason?: unknown; errorMessage?: unknown };
	if (typeof record.timestamp !== "number") return undefined;
	return JSON.stringify([record.role ?? null, record.timestamp, record.stopReason ?? null, record.errorMessage ?? null]);
}

function turnBoundary(messages: readonly AgentMessage[]): TurnBoundary {
	const identities = new WeakSet<object>();
	const keys = new Set<string>();
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		identities.add(message);
		const key = messageKey(message);
		if (key) keys.add(key);
	}
	return { identities, keys };
}

function isPreTurn(message: unknown, boundary: TurnBoundary): boolean {
	if (typeof message !== "object" || message === null) return false;
	if (boundary.identities.has(message)) return true;
	const key = messageKey(message);
	return key !== undefined && boundary.keys.has(key);
}

async function turnFailure(connection: AgentConnection, boundary: TurnBoundary): Promise<string | undefined> {
	const messages = await connection.getMessages();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (isPreTurn(message, boundary)) return undefined;
		const assistant = message as { stopReason?: string; errorMessage?: string };
		if (assistant.stopReason !== "error") return undefined;
		return assistant.errorMessage || "the model request failed";
	}
	return undefined;
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
	if (options.ownStdout !== false && !options.stream) {
		takeOverStdout();
	}

	let session: AcpSessionEntry | undefined;
	let bound = false;

	const stream =
		options.stream ?? acp.ndJsonStream(rawStdoutSink(), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

	const subscribeSession = (ctx: any, sessionId: string): AcpSessionEntry => {
		const entry: AcpSessionEntry = { id: sessionId, abort: undefined, unsubscribe: undefined };
		const mappingState: AcpEventMappingState = {};
		entry.unsubscribe = connection.subscribe((event) => {
			const notify = (update: Record<string, unknown>) =>
				void ctx.client.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => undefined);
			if (event.type === "heartbeats_changed") {
				notify({ sessionUpdate: "session_info_update", _meta: primeAgentMeta({ heartbeatsChanged: true }) });
				return;
			}
			if (event.type !== "session_event") return;
			for (const update of acpUpdatesForSessionEvent(event.event, mappingState)) notify(update);
		});
		return entry;
	};

	const ensureBound = async () => {
		if (bound) return;
		await options.bindHeadlessExtensions?.();
		bound = true;
	};

	const handle = acp
		.agent({ name: "prime-agent" })
		.onRequest("initialize", async () => ({
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
				sessionCapabilities: { close: {}, list: {} },
			},
			agentInfo: { name: "prime-agent", title: "Prime Agent", version: VERSION },
			_meta: primeAgentMeta({}),
		}))
		.onRequest("session/list", async (ctx: any) => {
			const params = (ctx.params ?? {}) as { cwd?: unknown; cursor?: unknown };
			const offset = sessionCursorOffset(params.cursor);
			const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : undefined;
			const saved = await connection.listSavedSessions("all");
			const matching = cwd ? saved.filter((item) => sameCwd(item.cwd, cwd)) : saved;
			const page = matching.slice(offset, offset + ACP_SESSION_PAGE_SIZE);
			const nextOffset = offset + page.length;
			return {
				sessions: page.map((item) => ({
					sessionId: item.id,
					cwd: item.cwd,
					...(item.name || item.firstMessage ? { title: item.name || item.firstMessage } : {}),
					updatedAt: item.modified.toISOString(),
				})),
				...(nextOffset < matching.length ? { nextCursor: sessionCursor(nextOffset) } : {}),
			};
		})
		.onRequest("session/load", async (ctx: any) => {
			if (session) {
				throw new Error(
					"prime-agent ACP mode hosts one session per connection; close the current session before loading another",
				);
			}
			await ensureBound();
			const params = ctx.params as { sessionId: string; cwd?: string };
			const saved = await connection.listSavedSessions("all");
			const target = saved.find((item) => item.id === params.sessionId);
			if (!target) throw new Error(`Unknown saved session: ${params.sessionId}`);
			const switched = await connection.switchSession(target.path, params.cwd ? { cwdOverride: params.cwd } : undefined);
			if (switched.cancelled) throw new Error(`Loading saved session was cancelled: ${params.sessionId}`);

			const entry = subscribeSession(ctx, params.sessionId);
			session = entry;
			try {
				for (const message of await connection.getMessages()) {
					for (const update of messageReplayUpdates(message)) {
						await ctx.client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
					}
				}
			} catch (error) {
				entry.unsubscribe?.();
				session = undefined;
				throw error;
			}
			return { sessionId: params.sessionId };
		})
		.onRequest("session/new", async (ctx: any) => {
			await ensureBound();
			if (session) {
				throw new Error(
					"prime-agent ACP mode hosts one session per connection; " +
						"start another prime-agent process for a second session",
				);
			}
			const requestedCwd = (ctx.params as { cwd?: unknown } | undefined)?.cwd;
			let cwdMismatch: { requested: string; actual: string } | undefined;
			if (typeof requestedCwd === "string" && requestedCwd.length > 0) {
				const actual = await connection
					.getState()
					.then((state) => state.cwd)
					.catch(() => undefined);
				if (actual && !sameCwd(requestedCwd, actual)) cwdMismatch = { requested: requestedCwd, actual };
			}
			const sessionId = randomUUID();
			session = subscribeSession(ctx, sessionId);
			return {
				sessionId,
				...(cwdMismatch ? { _meta: primeAgentMeta({ cwd: cwdMismatch }) } : {}),
			};
		})
		.onRequest("session/prompt", async (ctx: any) => {
			const params = ctx.params as { sessionId: string; prompt: readonly unknown[] };
			const entry = session?.id === params.sessionId ? session : undefined;
			if (!entry) throw new Error(`Unknown ACP session: ${params.sessionId}`);
			if (entry.abort) throw new Error("A prompt turn is already running for this ACP session");
			const abort = new AbortController();
			entry.abort = abort;

			try {
				const { text, images } = promptContent(params.prompt);
				const priorMessages = turnBoundary(await connection.getMessages());
				await connection.promptAndWait(text, images.length > 0 ? { images } : undefined);
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
				const failure = await turnFailure(connection, priorMessages);
				if (failure && !abort.signal.aborted) throw new Error(`prime-agent turn failed: ${failure}`);
				return { stopReason: acpStopReason({ cancelled: abort.signal.aborted, autonomous: status }) };
			} catch (error) {
				if (abort.signal.aborted) return { stopReason: "cancelled" satisfies AcpStopReason };
				throw error;
			} finally {
				if (entry.abort === abort) entry.abort = undefined;
			}
		})
		.onRequest("session/close", async (ctx: any) => {
			const params = ctx.params as { sessionId: string };
			if (session?.id !== params.sessionId) throw new Error(`Unknown ACP session: ${params.sessionId}`);
			const closing = session;
			session = undefined;
			closing.unsubscribe?.();
			if (closing.abort) {
				closing.abort.abort();
				await connection.abort().catch(() => undefined);
			}
			return {};
		})
		.onNotification("session/cancel", async (ctx: any) => {
			const params = ctx.params as { sessionId: string };
			if (session?.id !== params.sessionId || !session.abort) return;
			session.abort.abort();
			await connection.abort().catch(() => undefined);
		})
		.connect(stream);

	await handle.closed.catch(() => undefined);
	session?.abort?.abort();
	session?.unsubscribe?.();
	session = undefined;
	await connection.dispose().catch(() => undefined);
	if (options.stream) return undefined as never;
	return process.exit(0) as never;
}