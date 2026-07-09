/**
 * Built-in Herdr integration extension.
 *
 * Reports agent lifecycle state (working/idle/blocked) to the Herdr terminal
 * workspace manager via its Unix socket. This is the in-tree equivalent of
 * the extension that `herdr integration install pi` writes, so Prime Agent
 * works inside Herdr panes out of the box without a manual install step.
 *
 * Unlike the file-based integration (re-evaluated per session load by jiti),
 * this module is statically imported and evaluated once per process. All env
 * capture and state therefore live inside the factory, which the resource
 * loader invokes per session load — inside the daemon's client-env window —
 * so each daemon session captures its own pane identity.
 *
 * The factory is a complete no-op when `HERDR_ENV` is not `"1"` (i.e. when
 * not running inside a Herdr pane), so it is safe to always load.
 */

import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../../config.js";
import type { ExtensionAPI, ExtensionFactory } from "../types.js";

type AgentState = "working" | "blocked" | "idle";

/**
 * True when the user has installed Herdr's own file-based Pi integration
 * (`herdr integration install pi`). That extension is discovered and loaded
 * from the extensions directory like any other, and reports with the same
 * `herdr:pi` source but its own seq counter and agent label. Running both
 * reporters against one pane would make them race, so the built-in defers.
 */
function fileBasedIntegrationInstalled(): boolean {
	const candidates = [
		join(getAgentDir(), "extensions", "herdr-agent-state.ts"),
		join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts"),
	];
	return candidates.some((path) => existsSync(path));
}

interface QueuedState {
	state: AgentState;
	message?: string;
	seq: number;
}

const RETRYABLE_ERROR_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function parseDurationEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return fallback;
	}
	return parsed;
}

function lastAssistantMessage(messages: unknown[]): any | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as any;
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function retryableErrorMessage(event: any): string | undefined {
	const messages = Array.isArray(event?.messages) ? event.messages : [];
	const assistant = lastAssistantMessage(messages);
	if (assistant?.stopReason !== "error") {
		return undefined;
	}

	const errorMessage = String(assistant.errorMessage ?? "");
	if (!RETRYABLE_ERROR_PATTERN.test(errorMessage)) {
		return undefined;
	}
	return errorMessage || "retryable provider error";
}

export const herdrAgentStateExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	// Captured per factory invocation: the resource loader runs this during
	// session load, inside the daemon's client-env window, so these reflect the
	// session's own Herdr pane rather than the daemon's startup environment.
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const paneId = process.env.HERDR_PANE_ID;
	const enabled = process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;
	if (!enabled || fileBasedIntegrationInstalled()) {
		return;
	}

	const source = "herdr:pi";
	const agentLabel = "prime-agent";
	const idleDebounceMs = parseDurationEnv("HERDR_PI_IDLE_DEBOUNCE_MS", 250);
	const retryGraceMs = parseDurationEnv("HERDR_PI_RETRY_GRACE_MS", 2500);

	let reportSeq = Date.now() * 1000;
	let currentAgentSessionId: string | undefined;
	let currentAgentSessionPath: string | undefined;
	let sendInFlight = false;
	let queuedState: QueuedState | undefined;

	let agentActive = false;
	let retryHoldActive = false;
	let failureBlocked = false;
	let failureMessage: string | undefined;
	let blockedCount = 0;
	let blockedMessage: string | undefined;
	let lastState: AgentState | undefined;
	let lastMessage: string | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;

	function nextReportSeq(): number {
		reportSeq += 1;
		return reportSeq;
	}

	function sendRequest(request: unknown): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				socket.destroy();
				resolve();
			};

			const socket = createConnection(socketPath!);
			socket.on("error", finish);
			socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("data", finish);
			socket.on("end", finish);
			const timeout = setTimeout(finish, 500);
			timeout.unref?.();
		});
	}

	function updateSessionRef(ctx: any): void {
		try {
			const file = ctx?.sessionManager?.getSessionFile?.();
			currentAgentSessionPath = typeof file === "string" && file.startsWith("/") ? file : undefined;
		} catch {
			currentAgentSessionPath = undefined;
		}

		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
		} catch {
			currentAgentSessionId = undefined;
		}
	}

	function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
		if (currentAgentSessionPath) {
			return { ...params, agent_session_path: currentAgentSessionPath };
		}
		if (currentAgentSessionId) {
			return { ...params, agent_session_id: currentAgentSessionId };
		}
		return params;
	}

	function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
		return sendRequest({
			id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.report_agent",
			params: withSessionRef({
				pane_id: paneId,
				source,
				agent: agentLabel,
				state,
				message,
				seq,
			}),
		});
	}

	function queueState(state: AgentState, message?: string): void {
		queuedState = { state, message, seq: nextReportSeq() };
		if (!sendInFlight) {
			void drainStateQueue();
		}
	}

	async function drainStateQueue(): Promise<void> {
		if (sendInFlight) {
			return;
		}

		sendInFlight = true;
		try {
			while (queuedState) {
				const next = queuedState;
				queuedState = undefined;
				await sendState(next.state, next.message, next.seq);
			}
		} finally {
			sendInFlight = false;
			if (queuedState) {
				void drainStateQueue();
			}
		}
	}

	function releaseAgent(): Promise<void> {
		return sendRequest({
			id: `${source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			method: "pane.release_agent",
			params: {
				pane_id: paneId,
				source,
				agent: agentLabel,
				seq: nextReportSeq(),
			},
		});
	}

	function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
		if (timer) {
			clearTimeout(timer);
		}
	}

	function clearPendingTimers() {
		clearTimer(idleTimer);
		clearTimer(retryTimer);
		idleTimer = undefined;
		retryTimer = undefined;
	}

	function clearFailureState() {
		retryHoldActive = false;
		failureBlocked = false;
		failureMessage = undefined;
	}

	function desiredState(): { state: AgentState; message?: string } {
		if (blockedCount > 0) {
			return { state: "blocked", message: blockedMessage };
		}
		if (failureBlocked) {
			return { state: "blocked", message: failureMessage };
		}
		if (agentActive || retryHoldActive) {
			return { state: "working", message: undefined };
		}
		return { state: "idle", message: undefined };
	}

	function publishState(force = false) {
		const next = desiredState();
		if (!force && next.state === lastState && next.message === lastMessage) {
			return;
		}
		lastState = next.state;
		lastMessage = next.message;
		queueState(next.state, next.message);
	}

	function scheduleIdle() {
		clearPendingTimers();
		clearFailureState();
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			publishState();
		}, idleDebounceMs);
		idleTimer.unref?.();
	}

	function holdForRetry(message: string) {
		clearPendingTimers();
		retryHoldActive = true;
		failureBlocked = false;
		failureMessage = message;
		publishState();

		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			retryHoldActive = false;
			failureBlocked = true;
			publishState();
		}, retryGraceMs);
		retryTimer.unref?.();
	}

	pi.on("session_start", (_event, ctx) => {
		updateSessionRef(ctx);
		publishState(true);
	});

	pi.events.on("herdr:blocked", (data: any) => {
		if (!data?.active) {
			blockedCount = Math.max(0, blockedCount - 1);
			if (blockedCount === 0) {
				blockedMessage = undefined;
			}
			publishState();
			return;
		}

		clearPendingTimers();
		blockedCount += 1;
		blockedMessage = data.label;
		publishState();
	});

	pi.on("agent_start", () => {
		clearPendingTimers();
		clearFailureState();
		agentActive = true;
		publishState();
	});

	pi.on("agent_end", (event) => {
		if (!agentActive) {
			// Duplicate/late end events can arrive while auto-retry is already
			// holding the pane in Working. Do not let an unqualified duplicate end
			// cancel the retry hold and publish a false Idle.
			return;
		}

		agentActive = false;

		const retryableMessage = retryableErrorMessage(event);
		if (retryableMessage) {
			holdForRetry(retryableMessage);
			return;
		}

		scheduleIdle();
	});

	pi.on("session_shutdown", async () => {
		clearPendingTimers();
		await releaseAgent();
	});
};
