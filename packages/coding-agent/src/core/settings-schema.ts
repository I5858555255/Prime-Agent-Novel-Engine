/**
 * Machine-readable settings schema.
 *
 * Single source of truth for settings documentation, validation, and code generation.
 * Every setting in the Settings interface should have a corresponding entry here.
 */

export type SettingType =
	| "string"
	| "boolean"
	| "number"
	| "string[]"
	| "object"
	| "string | number"
	| "string | boolean";

export interface SettingEnum {
	values: string[];
}

export interface SettingDefinition {
	/** Dot-path key (e.g., "compaction.enabled") */
	key: string;
	/** Human-readable name */
	name: string;
	/** TypeScript type */
	type: SettingType;
	/** Default value as displayed in docs */
	default: string;
	/** Whether the setting can be "off" or has special values */
	nullable?: boolean;
	/** Allowed values for enum types */
	enum?: SettingEnum;
	/** Minimum value for numbers */
	min?: number;
	/** Maximum value for numbers */
	max?: number;
	/** Description of what the setting does */
	description: string;
	/** Nested settings under this key */
	children?: SettingDefinition[];
}

export interface SettingGroup {
	/** Group title */
	title: string;
	/** Settings in this group */
	settings: SettingDefinition[];
}

/** Top-level settings that are nested objects with their own defaults */
const NESTED_SETTINGS = new Set([
	"compaction",
	"autoRefine",
	"retry",
	"terminal",
	"images",
	"thinkingBudgets",
	"markdown",
	"bundledSkills",
	"warnings",
	"branchSummary",
	"telemetry",
	"agentTraces",
	"mcpServers",
]);

export const SETTING_GROUPS: SettingGroup[] = [
	{
		title: "Model & Thinking",
		settings: [
			{
				key: "defaultProvider",
				name: "defaultProvider",
				type: "string",
				default: "-",
				description: 'Default provider (e.g., "anthropic", "openai")',
			},
			{
				key: "defaultModel",
				name: "defaultModel",
				type: "string",
				default: "-",
				description: "Default model ID",
			},
			{
				key: "defaultThinkingLevel",
				name: "defaultThinkingLevel",
				type: "string",
				default: '"medium"',
				enum: { values: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
				description: "Default thinking/reasoning level",
			},
			{
				key: "hideThinkingBlock",
				name: "hideThinkingBlock",
				type: "boolean",
				default: "false",
				description: "Hide thinking blocks in output",
			},
			{
				key: "thinkingBudgets",
				name: "thinkingBudgets",
				type: "object",
				default: "-",
				description: "Custom token budgets per thinking level",
				children: [
					{
						key: "thinkingBudgets.minimal",
						name: "minimal",
						type: "number",
						default: "-",
						description: "Token budget for minimal thinking",
					},
					{
						key: "thinkingBudgets.low",
						name: "low",
						type: "number",
						default: "-",
						description: "Token budget for low thinking",
					},
					{
						key: "thinkingBudgets.medium",
						name: "medium",
						type: "number",
						default: "-",
						description: "Token budget for medium thinking",
					},
					{
						key: "thinkingBudgets.high",
						name: "high",
						type: "number",
						default: "-",
						description: "Token budget for high thinking",
					},
				],
			},
		],
	},
	{
		title: "UI & Display",
		settings: [
			{
				key: "theme",
				name: "theme",
				type: "string",
				default: '"dark"',
				description: 'Theme name ("dark", "light", or custom)',
			},
			{
				key: "quietStartup",
				name: "quietStartup",
				type: "boolean",
				default: "false",
				description: "Hide startup header",
			},
			{
				key: "treeFilterMode",
				name: "treeFilterMode",
				type: "string",
				default: '"user-only"',
				enum: { values: ["default", "no-tools", "user-only", "labeled-only", "all"] },
				description: 'Default filter for /tree: "default", "no-tools", "user-only", "labeled-only", "all"',
			},
			{
				key: "editorPaddingX",
				name: "editorPaddingX",
				type: "number",
				default: "0",
				min: 0,
				max: 3,
				description: "Horizontal padding for input editor (0-3)",
			},
			{
				key: "autocompleteMaxVisible",
				name: "autocompleteMaxVisible",
				type: "number",
				default: "5",
				min: 3,
				max: 20,
				description: "Max visible items in autocomplete dropdown (3-20)",
			},
			{
				key: "showHardwareCursor",
				name: "showHardwareCursor",
				type: "boolean",
				default: "false",
				description: "Show terminal cursor",
			},
		],
	},
	{
		title: "Telemetry",
		settings: [
			{
				key: "telemetry.enabled",
				name: "enabled",
				type: "boolean",
				default: "true",
				description: "Send pseudonymous aggregate usage and performance events",
			},
		],
	},
	{
		title: "Warnings",
		settings: [
			{
				key: "warnings.anthropicExtraUsage",
				name: "anthropicExtraUsage",
				type: "boolean",
				default: "true",
				description: "Show a warning when Anthropic subscription auth may use paid extra usage",
			},
		],
	},
	{
		title: "Compaction",
		settings: [
			{
				key: "compaction.enabled",
				name: "enabled",
				type: "boolean",
				default: "true",
				description: "Enable auto-compaction",
			},
			{
				key: "compaction.reserveTokens",
				name: "reserveTokens",
				type: "number",
				default: "16384",
				description: "Tokens reserved for LLM response",
			},
			{
				key: "compaction.keepRecentTokens",
				name: "keepRecentTokens",
				type: "number",
				default: "20000",
				description: "Recent tokens to keep (not summarized)",
			},
			{
				key: "compaction.agentCallable",
				name: "agentCallable",
				type: "boolean",
				default: "true",
				description: "Expose the compact skill so the model can request compaction",
			},
		],
	},
	{
		title: "Auto Refine",
		settings: [
			{
				key: "autoRefine.enabled",
				name: "enabled",
				type: "boolean",
				default: "true",
				description: "Enable automatic self-refinement",
			},
			{
				key: "autoRefine.turnInterval",
				name: "turnInterval",
				type: "number",
				default: "25",
				description: "Number of assistant turns between refinement passes",
			},
			{
				key: "autoRefine.compact",
				name: "compact",
				type: "boolean",
				default: "true",
				description: "Compact the session before refinement",
			},
			{
				key: "autoRefine.cooldownMs",
				name: "cooldownMs",
				type: "number",
				default: "1200000",
				description: "Cooldown between refinements in milliseconds (20 minutes)",
			},
		],
	},
	{
		title: "Branch Summary",
		settings: [
			{
				key: "branchSummary.reserveTokens",
				name: "reserveTokens",
				type: "number",
				default: "16384",
				description: "Tokens reserved for branch summarization",
			},
			{
				key: "branchSummary.skipPrompt",
				name: "skipPrompt",
				type: "boolean",
				default: "false",
				description: 'Skip "Summarize branch?" prompt on /tree navigation (defaults to no summary)',
			},
		],
	},
	{
		title: "Retry",
		settings: [
			{
				key: "retry.enabled",
				name: "enabled",
				type: "boolean",
				default: "true",
				description: "Enable automatic agent-level retry on transient errors",
			},
			{
				key: "retry.maxRetries",
				name: "maxRetries",
				type: "number",
				default: "3",
				description: "Maximum agent-level retry attempts",
			},
			{
				key: "retry.baseDelayMs",
				name: "baseDelayMs",
				type: "number",
				default: "2000",
				description: "Base delay for agent-level exponential backoff (2s, 4s, 8s)",
			},
			{
				key: "retry.provider.timeoutMs",
				name: "timeoutMs",
				type: "number",
				default: "SDK default",
				description: "Provider/SDK request timeout in milliseconds",
			},
			{
				key: "retry.provider.maxRetries",
				name: "maxRetries",
				type: "number",
				default: "SDK default",
				description: "Provider/SDK retry attempts",
			},
			{
				key: "retry.provider.maxRetryDelayMs",
				name: "maxRetryDelayMs",
				type: "number",
				default: "60000",
				description: "Max server-requested delay before failing (60s)",
			},
		],
	},
	{
		title: "Message Delivery",
		settings: [
			{
				key: "steeringMode",
				name: "steeringMode",
				type: "string",
				default: '"one-at-a-time"',
				enum: { values: ["all", "one-at-a-time"] },
				description: 'How steering messages are sent: "all" or "one-at-a-time"',
			},
			{
				key: "followUpMode",
				name: "followUpMode",
				type: "string",
				default: '"one-at-a-time"',
				enum: { values: ["all", "one-at-a-time"] },
				description: 'How follow-up messages are sent: "all" or "one-at-a-time"',
			},
			{
				key: "transport",
				name: "transport",
				type: "string",
				default: '"auto"',
				enum: { values: ["sse", "websocket", "auto"] },
				description:
					'Preferred transport for providers that support multiple transports: "sse", "websocket", or "auto"',
			},
		],
	},
	{
		title: "Terminal & Images",
		settings: [
			{
				key: "terminal.showImages",
				name: "showImages",
				type: "boolean",
				default: "true",
				description: "Show image type and dimensions in terminal",
			},
			{
				key: "terminal.clearOnShrink",
				name: "clearOnShrink",
				type: "boolean",
				default: "false",
				description: "Clear empty rows when content shrinks (can cause flicker)",
			},
			{
				key: "terminal.showTerminalProgress",
				name: "showTerminalProgress",
				type: "boolean",
				default: "false",
				description: "OSC 9;4 terminal progress indicators",
			},
			{
				key: "terminal.fullscreen",
				name: "fullscreen",
				type: "boolean",
				default: "true",
				description: "Alternate-screen rendering with scrollable transcript",
			},
			{
				key: "terminal.fullscreenMouse",
				name: "fullscreenMouse",
				type: "boolean",
				default: "true",
				description: "Wheel scrolling in fullscreen; disable if it breaks selection",
			},
			{
				key: "images.autoResize",
				name: "autoResize",
				type: "boolean",
				default: "true",
				description: "Resize images to 2000x2000 max",
			},
			{
				key: "images.blockImages",
				name: "blockImages",
				type: "boolean",
				default: "false",
				description: "Block all images from being sent to LLM",
			},
		],
	},
	{
		title: "Shell",
		settings: [
			{
				key: "shellPath",
				name: "shellPath",
				type: "string",
				default: "-",
				description: "Custom shell path (e.g., for Cygwin on Windows)",
			},
			{
				key: "shellCommandPrefix",
				name: "shellCommandPrefix",
				type: "string",
				default: "-",
				description: 'Prefix for every bash command (e.g., "shopt -s expand_aliases")',
			},
			{
				key: "npmCommand",
				name: "npmCommand",
				type: "string[]",
				default: "-",
				description:
					'Command argv used for npm package lookup/install operations (e.g., ["mise", "exec", "node@20", "--", "npm"])',
			},
		],
	},
	{
		title: "Daemon",
		settings: [
			{
				key: "idleEvictionMinutes",
				name: "idleEvictionMinutes",
				type: "string | number",
				default: "90",
				description:
					'Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; "off" disables both. Global-only setting.',
			},
		],
	},
	{
		title: "Sessions",
		settings: [
			{
				key: "sessionDir",
				name: "sessionDir",
				type: "string",
				default: "-",
				description: "Directory where session files are stored. Accepts absolute or relative paths, plus ~.",
			},
		],
	},
	{
		title: "Model Cycling",
		settings: [
			{
				key: "enabledModels",
				name: "enabledModels",
				type: "string[]",
				default: "-",
				description: "Model patterns for Ctrl+P cycling (same format as --models CLI flag)",
			},
		],
	},
	{
		title: "Markdown",
		settings: [
			{
				key: "markdown.codeBlockIndent",
				name: "codeBlockIndent",
				type: "string",
				default: '"  "',
				description: "Indentation for code blocks",
			},
		],
	},
	{
		title: "Resources",
		settings: [
			{
				key: "packages",
				name: "packages",
				type: "string[]",
				default: "[]",
				description: "npm/git packages to load resources from",
			},
			{
				key: "extensions",
				name: "extensions",
				type: "string[]",
				default: "[]",
				description: "Local extension file paths or directories",
			},
			{
				key: "skills",
				name: "skills",
				type: "string[]",
				default: "[]",
				description: "Local skill file paths or directories",
			},
			{
				key: "prompts",
				name: "prompts",
				type: "string[]",
				default: "[]",
				description: "Local prompt template paths or directories",
			},
			{
				key: "themes",
				name: "themes",
				type: "string[]",
				default: "[]",
				description: "Local theme file paths or directories",
			},
			{
				key: "enableSkillCommands",
				name: "enableSkillCommands",
				type: "boolean",
				default: "true",
				description: "Register skills as /skill:name commands",
			},
			{
				key: "enableBuiltinSkills",
				name: "enableBuiltinSkills",
				type: "boolean",
				default: "true",
				description: "Load built-in skills shipped with prime-agent",
			},
			{
				key: "bundledSkills.websearch",
				name: "websearch",
				type: "boolean",
				default: "true",
				description: "Load the built-in websearch skill",
			},
		],
	},
	{
		title: "Agent Traces",
		settings: [
			{
				key: "agentTraces.enabled",
				name: "enabled",
				type: "boolean",
				default: "false",
				description: "Enable agent traces for debugging",
			},
		],
	},
];

/** Flat list of all setting definitions (including children) */
export function flattenSettings(groups: SettingGroup[] = SETTING_GROUPS): SettingDefinition[] {
	const result: SettingDefinition[] = [];
	for (const group of groups) {
		for (const setting of group.settings) {
			result.push(setting);
			if (setting.children) {
				result.push(...setting.children);
			}
		}
	}
	return result;
}

/** Get all top-level setting keys (excluding nested children) */
export function getTopLevelKeys(groups: SettingGroup[] = SETTING_GROUPS): string[] {
	const keys: string[] = [];
	for (const group of groups) {
		for (const setting of group.settings) {
			keys.push(setting.key);
		}
	}
	return keys;
}

/** Check if a key is a nested settings object */
export function isNestedSetting(key: string): boolean {
	return NESTED_SETTINGS.has(key);
}
