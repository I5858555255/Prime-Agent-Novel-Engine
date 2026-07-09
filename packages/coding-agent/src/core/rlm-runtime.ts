import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";
import type { HostRequestHandler } from "./kernel/index.js";

export interface RlmUsage {
	prompt_tokens: number;
	completion_tokens: number;
}

export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	/** Source of the IPython cell that issued this rlm.run call, when available. */
	cellSourceCode?: string;
}

export interface RlmRunResult {
	answer: string;
	usage: RlmUsage;
	turns: number;
	session_dir: string | null;
	/** Stable id of the persistent subagent this run used, when persistence was requested. */
	persistent_id?: string;
	/** True when this run reopened a persistent subagent's saved history. */
	reopened?: boolean;
}

export interface RlmInternalRunResult extends RlmRunResult {
	assistantUsage: Usage;
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<RlmRunResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adapt an RlmRunHandler into the typed "rlm.run" handler for the kernel host bridge. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler({ prompt: payload.prompt, kwargs, cellSourceCode });
		return result as unknown as Record<string, unknown>;
	};
}

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Source of the IPython cell that spawned this subagent, for display. */
	spawnCode?: string;
	/**
	 * Existing session file to reopen for a persistent (reopenable) subagent. When
	 * set, the runtime hydrates this session's saved history instead of starting a
	 * fresh conversation.
	 */
	existingSessionFile?: string;
	/**
	 * System prompt (append) applied to this subagent. For a persistent subagent it
	 * is stored with its history and re-applied on every reopen.
	 */
	subagentSystemPrompt?: string;
}

/** Terminal status of an RLM child run, passed to the host when releasing its runtime. */
export type RlmSubagentReleaseStatus = "done" | "error" | "cancelled";

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	releaseRlmSubagentRuntime?(
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: RlmSubagentReleaseStatus,
	): Promise<void>;
	/**
	 * Fully close a retained (finished, resident) subagent runtime by its child id,
	 * evicting any host-side registry entry (e.g. the daemon's ActiveSessionState) in
	 * addition to disposing the session. Called before a persistent subagent is reopened
	 * under the same id so the stale resident session can't be observed, messaged, or
	 * re-stamped. Returns true when a retained runtime was found and closed.
	 */
	closeRetainedRlmSubagentRuntime?(childId: string): Promise<boolean>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
