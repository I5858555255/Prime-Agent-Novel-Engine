import type { ToolDefinition } from "../../core/extensions/index.js";
import type { AgentConnectionToolDefinition } from "./types.js";

type ReplayBuiltInToolName = "bash" | "edit";

function getReplayBuiltInToolName(definition: ToolDefinition): ReplayBuiltInToolName | undefined {
	const value = (definition as { replayBuiltInToolName?: unknown }).replayBuiltInToolName;
	return value === "bash" || value === "edit" ? value : undefined;
}

export function createAgentConnectionToolDefinition(
	definition: ToolDefinition | undefined,
): AgentConnectionToolDefinition | undefined {
	if (!definition) {
		return undefined;
	}

	const replayBuiltInToolName = getReplayBuiltInToolName(definition);
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		...(definition.promptSnippet !== undefined ? { promptSnippet: definition.promptSnippet } : {}),
		...(definition.promptGuidelines !== undefined ? { promptGuidelines: [...definition.promptGuidelines] } : {}),
		parameters: definition.parameters,
		...(definition.renderShell !== undefined ? { renderShell: definition.renderShell } : {}),
		...(replayBuiltInToolName !== undefined ? { replayBuiltInToolName } : {}),
	};
}
