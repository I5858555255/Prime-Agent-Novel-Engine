import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../core/model-registry.js";
import type { AgentStatus, AgentTaskState } from "../../core/session-manager.js";
import type { ActiveSessionState } from "./active-session-state.js";

// Periodic backstop that refreshes "what it's doing" lines for long-running
// sessions; turn-end activity drives the timely idle verdict separately.
const SWEEP_INTERVAL_MS = 25_000;
// Wait for the agent to settle after a turn before judging completion, so a
// tool-use loop's rapid turn_end bursts collapse into one summarization.
const SETTLE_DEBOUNCE_MS = 2_000;

// Small open-weight model self-hosted on Prime Inference for background status
// summaries — kept off the proxied frontier models. Resolved through the
// session's own registry; when unavailable the daemon skips summarization and
// the agents view falls back to its streaming-only heuristic.
const SUMMARY_MODEL_PROVIDER = "prime-inference";
const SUMMARY_MODEL_ID = "nvidia/nemotron-3-nano-30b-a3b";

// Feed more than the latest message so the summary reflects the recent arc of
// work, not a single line, while staying small for a cheap model.
const SUMMARY_CONTEXT_MESSAGES = 8;
const SUMMARY_MAX_CHARS_PER_MESSAGE = 600;
// Generous so a chatty model that narrates before answering still reaches the
// SUMMARY line; strict parsing discards everything before it.
const SUMMARY_MAX_TOKENS = 400;

// Concise on purpose: the earlier (compaction) prompt is paragraphs long; a
// status line only needs a short clause plus a completion verdict.
export const AGENT_STATUS_SYSTEM_PROMPT = `You generate a status line for an AI coding agent dashboard. You are given the recent conversation between a user and the agent, plus whether the agent is currently working or idle.

Output ONLY these two lines, nothing before or after. Do not think out loud, explain, or add any other text.
SUMMARY: a present-tense clause, at most 12 words, saying what the agent is doing or just did, no trailing period
STATUS: one of WORKING, NEEDS_INPUT, COMPLETED

STATUS meaning:
- WORKING: the agent is mid-task and still acting.
- COMPLETED: the agent finished its turn AND the user's request is fully done with nothing left.
- NEEDS_INPUT: the agent finished its turn but the task is not fully done — it asked a question, hit a blocker, or needs more prompting.
When the agent is idle and you are unsure between COMPLETED and NEEDS_INPUT, choose NEEDS_INPUT.

Example:
SUMMARY: Refactoring the auth middleware and updating its tests
STATUS: WORKING`;

export interface AgentStatusResult {
	summary: string;
	taskState?: AgentTaskState;
}

/** Resolve the cheap summary model, or undefined when it has no configured auth. */
export function resolveSummaryModel(registry: ModelRegistry): Model<Api> | undefined {
	const model = registry.find(SUMMARY_MODEL_PROVIDER, SUMMARY_MODEL_ID);
	if (model && registry.hasConfiguredAuth(model)) {
		return model;
	}
	return undefined;
}

function messageText(content: unknown): { text: string; tools: string[] } {
	if (typeof content === "string") {
		return { text: content, tools: [] };
	}
	if (!Array.isArray(content)) {
		return { text: "", tools: [] };
	}
	const parts: string[] = [];
	const tools: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) {
			continue;
		}
		const type = (block as { type?: unknown }).type;
		if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		} else if (type === "tool_use" || type === "toolUse") {
			const name = (block as { name?: unknown }).name;
			if (typeof name === "string") {
				tools.push(name);
			}
		}
	}
	return { text: parts.join("\n"), tools };
}

function clamp(text: string, max: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * Serialize the trailing slice of a conversation into a compact prompt body.
 * Tool calls are noted by name so the summary can mention concrete activity
 * without dragging in full tool arguments or output.
 */
export function buildStatusContext(messages: readonly AgentMessage[], isWorking: boolean): string {
	const recent = messages.slice(-SUMMARY_CONTEXT_MESSAGES);
	const lines: string[] = [];
	for (const message of recent) {
		const role = message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") {
			continue;
		}
		const { text, tools } = messageText(message.content);
		const body = clamp(text, SUMMARY_MAX_CHARS_PER_MESSAGE);
		const toolNote = tools.length > 0 ? `[tools: ${[...new Set(tools)].join(", ")}]` : "";
		const rendered = [body, toolNote].filter((part) => part.length > 0).join(" ");
		if (rendered) {
			lines.push(`${role}: ${rendered}`);
		}
	}
	const state = isWorking ? "working" : "idle (finished its turn)";
	return `<agent-state>${state}</agent-state>\n<conversation>\n${lines.join("\n")}\n</conversation>`;
}

/**
 * Parse the two-line model reply into a summary and (for idle sessions) a
 * completion verdict. Strict on purpose: chatty/reasoning models narrate before
 * answering, so we require an explicit `SUMMARY:` line (taking the last one, in
 * case the answer follows reasoning) and never fall back to free text — that
 * would surface the model's chain-of-thought as the recap. Returns undefined
 * when no usable summary line was produced. WORKING-while-idle and unrecognized
 * verdicts fall back to needs_input so a session is never marked complete on a
 * malformed or hedged reply.
 */
export function parseAgentStatusResponse(text: string, isWorking: boolean): AgentStatusResult | undefined {
	// Drop inline reasoning some open models emit (<think>, <thinking>,
	// <reasoning>, <redacted_thinking>), including any unclosed leftover tags.
	const reasoningTag = /<\/?(?:think|thinking|reasoning|redacted_thinking)>/gi;
	const cleaned = text
		.replace(/<(think|thinking|reasoning|redacted_thinking)>[\s\S]*?<\/\1>/gi, " ")
		.replace(reasoningTag, " ");
	let summary: string | undefined;
	let status: string | undefined;
	for (const rawLine of cleaned.split("\n")) {
		const line = rawLine.trim();
		const summaryMatch = /^summary\s*:\s*(.+)$/i.exec(line);
		if (summaryMatch) {
			const candidate = summaryMatch[1]!.trim().replace(/[.\s]+$/, "");
			// Skip an echoed prompt template (e.g. "<one present-tense clause…>").
			if (candidate && !candidate.startsWith("<") && !/present-tense|12 words/i.test(candidate)) {
				summary = candidate;
			}
			continue;
		}
		const statusMatch = /^status\s*:\s*([a-z_]+)/i.exec(line);
		if (statusMatch) {
			status = statusMatch[1]!.toUpperCase();
		}
	}
	if (!summary) {
		return undefined;
	}
	if (isWorking) {
		return { summary };
	}
	const taskState: AgentTaskState = status === "COMPLETED" ? "completed" : "needs_input";
	return { summary, taskState };
}

export interface GenerateAgentStatusParams {
	registry: ModelRegistry;
	messages: readonly AgentMessage[];
	isWorking: boolean;
	signal?: AbortSignal;
}

/**
 * Run one cheap model call to produce a fresh status for a session. Returns
 * undefined when summarization is unavailable (no cheap model / auth), the
 * conversation is empty, or the call fails — callers then leave status as-is.
 */
export async function generateAgentStatus(params: GenerateAgentStatusParams): Promise<AgentStatusResult | undefined> {
	const { registry, messages, isWorking, signal } = params;
	if (messages.length === 0) {
		return undefined;
	}
	const model = resolveSummaryModel(registry);
	if (!model) {
		return undefined;
	}
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return undefined;
	}
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: AGENT_STATUS_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: buildStatusContext(messages, isWorking) }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: SUMMARY_MAX_TOKENS, apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		if (response.stopReason === "error") {
			return undefined;
		}
		const textContent = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return parseAgentStatusResponse(textContent, isWorking);
	} catch {
		return undefined;
	}
}

/** True when the new status differs enough from the stored one to be worth broadcasting. */
export function agentStatusChanged(previous: AgentStatus | undefined, next: AgentStatusResult): boolean {
	if (!previous) {
		return true;
	}
	return previous.summary !== next.summary || previous.taskState !== next.taskState;
}

function isSessionWorking(state: ActiveSessionState): boolean {
	const session = state.runtime.session;
	return session.isStreaming || session.isCompacting || session.pendingMessageCount > 0;
}

/**
 * Owns background status summarization for daemon-hosted top-level sessions.
 * A periodic sweep refreshes working sessions; turn-end activity (debounced)
 * drives the idle completion verdict. Status is kept in memory on the session
 * state (the agents view picks it up on its next poll) and the settled idle
 * verdict is persisted append-only so it survives a daemon restart.
 */
export class DaemonSessionSummarizer {
	private interval: ReturnType<typeof setInterval> | undefined;
	private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly listTopLevelSessions: () => readonly ActiveSessionState[],
		// Notified when a session's status text changes, so the daemon can push a
		// live recap to that session's attached clients.
		private readonly onStatusChanged?: (state: ActiveSessionState) => void,
		// Injectable for tests; defaults to the real cheap-model call.
		private readonly generate: (
			params: GenerateAgentStatusParams,
		) => Promise<AgentStatusResult | undefined> = generateAgentStatus,
	) {}

	start(): void {
		if (this.interval) {
			return;
		}
		this.interval = setInterval(() => {
			for (const state of this.listTopLevelSessions()) {
				void this.summarize(state);
			}
		}, SWEEP_INTERVAL_MS);
		this.interval.unref?.();
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
	}

	/** Drop any pending work for a session that is closing. */
	forget(activeSessionId: string): void {
		const timer = this.debounceTimers.get(activeSessionId);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(activeSessionId);
		}
	}

	/** Seed in-memory status from the persisted entry when a session is added. */
	seed(state: ActiveSessionState): void {
		if (state.summaryState) {
			return;
		}
		const persisted = state.runtime.session.sessionManager.getLatestAgentStatus();
		if (persisted) {
			state.summaryState = persisted;
		}
	}

	/** Called when a session finishes a turn; debounce until the agent settles. */
	notifyActivity(state: ActiveSessionState): void {
		if (state.runtime.metadata.kind === "subagent") {
			return;
		}
		const id = state.activeSessionId;
		const existing = this.debounceTimers.get(id);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.debounceTimers.delete(id);
			void this.summarize(state);
		}, SETTLE_DEBOUNCE_MS);
		timer.unref?.();
		this.debounceTimers.set(id, timer);
	}

	private async summarize(state: ActiveSessionState): Promise<void> {
		if (state.runtime.metadata.kind === "subagent") {
			return;
		}
		const id = state.activeSessionId;
		if (this.inFlight.has(id)) {
			return;
		}
		const session = state.runtime.session;
		const messages = session.messages;
		if (messages.length === 0) {
			return;
		}
		const messageCount = messages.length;
		const isWorking = isSessionWorking(state);
		const previous = state.summaryState;
		// Skip when nothing changed, unless an idle session still owes a completion
		// verdict for its current (settled) content.
		const contentUnchanged = previous?.basedOnMessageCount === messageCount;
		const owesIdleVerdict = !isWorking && previous?.taskState === undefined;
		if (contentUnchanged && !owesIdleVerdict) {
			return;
		}

		this.inFlight.add(id);
		try {
			const result = await this.generate({ registry: session.modelRegistry, messages, isWorking });
			if (!result) {
				return;
			}
			// The model call is async: the session may have started a new turn or
			// begun streaming while it ran. Discard a result that no longer matches
			// the live state so we never record (or persist) a verdict for a turn
			// that has moved on, nor append while the agent might be writing.
			if (isSessionWorking(state) !== isWorking || session.messages.length !== messageCount) {
				return;
			}
			const status: AgentStatus = {
				summary: result.summary,
				taskState: result.taskState,
				basedOnMessageCount: messageCount,
			};
			const changed = agentStatusChanged(previous, result);
			state.summaryState = status;
			// Persist only settled idle verdicts: a stable status to restore on
			// restart, and no writes interleaved with the agent's own streaming.
			if (!isWorking) {
				try {
					session.sessionManager.appendAgentStatus(status);
				} catch {
					// Persistence is best-effort; the in-memory status still shows.
				}
			}
			if (changed) {
				this.onStatusChanged?.(state);
			}
		} finally {
			this.inFlight.delete(id);
		}
	}
}
