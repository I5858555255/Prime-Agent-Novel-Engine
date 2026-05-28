import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface AgentSessionRuntimeConfig {
	cwd?: string;
	agentDir?: string;
	sessionDir?: string;
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	skills?: string[];
	noSkills?: boolean;
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	extensionFlagValues?: Record<string, boolean | string>;
}

export function mergeAgentSessionRuntimeConfig(
	base: AgentSessionRuntimeConfig,
	override?: AgentSessionRuntimeConfig,
): AgentSessionRuntimeConfig {
	if (!override) {
		return cloneAgentSessionRuntimeConfig(base);
	}
	return {
		...base,
		...override,
		appendSystemPrompt: cloneArray(override.appendSystemPrompt ?? base.appendSystemPrompt),
		models: cloneArray(override.models ?? base.models),
		tools: cloneArray(override.tools ?? base.tools),
		extensions: cloneArray(override.extensions ?? base.extensions),
		skills: cloneArray(override.skills ?? base.skills),
		promptTemplates: cloneArray(override.promptTemplates ?? base.promptTemplates),
		themes: cloneArray(override.themes ?? base.themes),
		extensionFlagValues:
			base.extensionFlagValues || override.extensionFlagValues
				? { ...(base.extensionFlagValues ?? {}), ...(override.extensionFlagValues ?? {}) }
				: undefined,
	};
}

function cloneAgentSessionRuntimeConfig(config: AgentSessionRuntimeConfig): AgentSessionRuntimeConfig {
	return {
		...config,
		appendSystemPrompt: cloneArray(config.appendSystemPrompt),
		models: cloneArray(config.models),
		tools: cloneArray(config.tools),
		extensions: cloneArray(config.extensions),
		skills: cloneArray(config.skills),
		promptTemplates: cloneArray(config.promptTemplates),
		themes: cloneArray(config.themes),
		extensionFlagValues: config.extensionFlagValues ? { ...config.extensionFlagValues } : undefined,
	};
}

function cloneArray<T>(value: T[] | undefined): T[] | undefined {
	return value ? [...value] : undefined;
}
