import type { SourceInfo } from "./source-info.js";

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffText"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "toolDiffAddedBg"
	| "toolDiffRemovedBg"
	| "toolPanelBg";

export type ThemeColorMode = "truecolor" | "256color";

/** Theme contract available to custom tool renderers in interactive and headless modes. */
export interface ToolRenderTheme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	readonly colorMode: ThemeColorMode;
	fg(color: ThemeColor, text: string): string;
	bg(color: ThemeBg, text: string): string;
	getEditorBackgroundColor(): ((text: string) => string) | undefined;
	getUserMessageBackgroundColor(): (text: string) => string;
	getPopupBackgroundColor(): (text: string) => string;
	getSelectionBackgroundColor(): (text: string) => string;
	getAdaptiveAccentColor(): (text: string) => string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
	strikethrough(text: string): string;
	getFgAnsi(color: ThemeColor): string;
	getBgAnsi(color: ThemeBg): string;
	getColorMode(): ThemeColorMode;
	getThinkingBorderColor(
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
	): (text: string) => string;
	getBashModeBorderColor(): (text: string) => string;
}
