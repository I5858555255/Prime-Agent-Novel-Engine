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
}

export interface RlmInternalRunResult extends RlmRunResult {
	assistantUsage: Usage;
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<RlmRunResult>;

// --- Persistent / background sub-agent requests ---

export interface RlmSendCreateRequest {
	name: string;
	max_tokens?: number;
	[key: string]: unknown;
}

export interface RlmSendCreateResult {
	session_dir: string | null;
}

export interface RlmSendAdvanceRequest {
	name: string;
	prompt: string;
}

export interface RlmSendCloseRequest {
	name: string;
}

export type RlmSendCreateHandler = (request: RlmSendCreateRequest) => Promise<RlmSendCreateResult>;
export type RlmSendAdvanceHandler = (request: RlmSendAdvanceRequest) => Promise<RlmRunResult>;
export type RlmSendCloseHandler = (request: RlmSendCloseRequest) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adapt an RlmSendCreateHandler into the typed "rlm.send.create" handler for the kernel host bridge. */
export function createRlmSendCreateHostHandler(handler: RlmSendCreateHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.name !== "string") {
			throw new Error("rlm.send.create name must be a string");
		}
		const request: RlmSendCreateRequest = {
			name: payload.name,
			max_tokens: typeof payload.max_tokens === "number" ? payload.max_tokens : undefined,
		};
		const result = await handler(request);
		return result as unknown as Record<string, unknown>;
	};
}

/** Adapt an RlmSendAdvanceHandler into the typed "rlm.send.advance" handler for the kernel host bridge. */
export function createRlmSendAdvanceHostHandler(handler: RlmSendAdvanceHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.name !== "string") {
			throw new Error("rlm.send.advance name must be a string");
		}
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.send.advance prompt must be a string");
		}
		const result = await handler({ name: payload.name, prompt: payload.prompt });
		return result as unknown as Record<string, unknown>;
	};
}

/** Adapt an RlmSendCloseHandler into the typed "rlm.send.close" handler for the kernel host bridge. */
export function createRlmSendCloseHostHandler(handler: RlmSendCloseHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.name !== "string") {
			throw new Error("rlm.send.close name must be a string");
		}
		await handler({ name: payload.name });
		return {};
	};
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
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Source of the IPython cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Optional per-request output token cap for the child agent. */
	maxTokens?: number;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	releaseRlmSubagentRuntime?(runtime: RlmSubagentRuntime, options: CreateRlmSubagentRuntimeOptions): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
