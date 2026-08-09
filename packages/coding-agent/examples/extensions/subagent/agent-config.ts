import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	isModelThinkingLevel,
	MODEL_THINKING_LEVELS,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export function parseAgentConfig(
	frontmatter: Record<string, unknown>,
	body: string,
	source: "user" | "project",
	filePath: string,
): AgentConfig | undefined {
	const name = frontmatter.name;
	const description = frontmatter.description;
	if (typeof name !== "string" || !name || typeof description !== "string" || !description) {
		return undefined;
	}
	if (
		frontmatter.thinking !== undefined &&
		(typeof frontmatter.thinking !== "string" || !frontmatter.thinking.trim())
	) {
		return undefined;
	}

	const tools =
		typeof frontmatter.tools === "string"
			? frontmatter.tools
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean)
			: undefined;

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

export type AgentThinkingResolution =
	| {
			ok: true;
			requestedThinking: ModelThinkingLevel | undefined;
			thinking: ModelThinkingLevel | undefined;
			availableThinkingLevels: ModelThinkingLevel[];
	  }
	| { ok: false; error: string };

export function resolveAgentThinking(agent: AgentConfig, model: Model<Api> | undefined): AgentThinkingResolution {
	if (agent.thinking === undefined) {
		return { ok: true, requestedThinking: undefined, thinking: undefined, availableThinkingLevels: [] };
	}
	if (!isModelThinkingLevel(agent.thinking)) {
		return {
			ok: false,
			error: `Invalid thinking level "${agent.thinking}" for agent "${agent.name}". Expected one of: ${MODEL_THINKING_LEVELS.join(", ")}.`,
		};
	}
	if (!model) {
		return { ok: false, error: `Cannot resolve thinking for agent "${agent.name}" without a selected model.` };
	}

	const availableThinkingLevels = getSupportedThinkingLevels(model);
	if (availableThinkingLevels.length === 0) {
		return {
			ok: false,
			error: `No thinking levels are configured for model "${model.provider}/${model.id}" used by agent "${agent.name}".`,
		};
	}
	return {
		ok: true,
		requestedThinking: agent.thinking,
		thinking: clampThinkingLevel(model, agent.thinking),
		availableThinkingLevels,
	};
}

export interface ResolvedAgentProcessConfig {
	model?: string;
	thinking?: ModelThinkingLevel;
}

export type AgentProcessResolution =
	| {
			ok: true;
			config: ResolvedAgentProcessConfig;
			requestedThinking: string | undefined;
	  }
	| { ok: false; error: string };

export interface AgentModelResolution {
	model: Model<Api> | undefined;
	warning?: string;
	error?: string;
}

export function resolveAgentProcessConfig(
	agent: AgentConfig,
	currentModel: Model<Api> | undefined,
	resolveModel: (selector: string) => AgentModelResolution,
): AgentProcessResolution {
	if (agent.thinking === undefined) {
		return { ok: true, config: { model: agent.model }, requestedThinking: undefined };
	}

	let model = currentModel;
	if (agent.model) {
		const resolved = resolveModel(agent.model);
		if (resolved.error || resolved.warning || !resolved.model) {
			return {
				ok: false,
				error:
					resolved.error ??
					resolved.warning ??
					`Could not resolve model "${agent.model}" for agent "${agent.name}".`,
			};
		}
		model = resolved.model;
	}

	const thinking = resolveAgentThinking(agent, model);
	if (!thinking.ok) return thinking;
	return {
		ok: true,
		config: {
			model: model ? `${model.provider}/${model.id}` : agent.model,
			thinking: thinking.thinking,
		},
		requestedThinking: thinking.requestedThinking,
	};
}

export function buildAgentProcessArgs(agent: AgentConfig, resolved: ResolvedAgentProcessConfig): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (resolved.model) args.push("--model", resolved.model);
	if (resolved.thinking) args.push("--thinking", resolved.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	return args;
}
