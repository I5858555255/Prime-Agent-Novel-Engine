import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "./extensions/index.js";
import type { SubagentRuntimeHost } from "./rlm-runtime.js";

export interface AgentSessionRuntimeOptions {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	noTools?: "all" | "builtin";
	customTools?: ToolDefinition[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	includeGoalTools?: boolean;
	autoActivateGoalTools?: boolean;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	rlmSessionDir?: string;
	rlmParentNodeId?: string;
	subagentRuntimeHost?: SubagentRuntimeHost;
}
