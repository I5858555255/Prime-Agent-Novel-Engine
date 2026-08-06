import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Shared canonical list and validator for CLI and core RLM thinking levels. */
export const VALID_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}
