import { type Component, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";

export type CompactionReason = "manual" | "threshold" | "overflow" | "engine";

export interface CompactionBreakOptions {
	summary: string;
	tokensBefore: number;
	reason?: CompactionReason;
	preCompactionTurns?: number;
	kernelRestarted?: boolean;
	timestamp?: number;
	expanded?: boolean;
}

export class CompactionBreakComponent implements Component {
	private options: CompactionBreakOptions;
	private markdownTheme: MarkdownTheme;

	constructor(options: CompactionBreakOptions, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		this.options = {
			reason: "engine",
			kernelRestarted: true,
			...options,
		};
		this.markdownTheme = markdownTheme;
	}

	setExpanded(expanded: boolean): void {
		this.options = { ...this.options, expanded };
	}

	update(options: Partial<CompactionBreakOptions>): void {
		this.options = { ...this.options, ...options };
	}

	invalidate(): void {
		// No render cache.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];
		lines.push(this.rule(safeWidth));
		lines.push(
			truncateToWidth(`  ${theme.bold("compaction break")} ${theme.fg("muted", this.reasonText())}`, safeWidth),
		);
		lines.push(
			truncateToWidth(
				`  ${theme.fg("muted", `pre-compaction transcript collapsed: ${this.collapsedTranscriptText()}`)}`,
				safeWidth,
			),
		);
		if (this.options.kernelRestarted) {
			lines.push(truncateToWidth(`  ${theme.fg("warning", "kernel restarted - variables wiped")}`, safeWidth));
		}

		if (this.options.expanded) {
			lines.push(truncateToWidth(`  ${theme.fg("customMessageLabel", "handoff summary")}`, safeWidth));
			const summary = this.options.summary.trim() || "(empty summary)";
			const markdown = new Markdown(this.quote(summary), 2, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			});
			lines.push(...markdown.render(safeWidth));
		} else {
			lines.push(
				truncateToWidth(
					`  ${theme.fg("customMessageText", "handoff summary hidden")} (${keyHint("app.tools.expand", "to expand")})`,
					safeWidth,
				),
			);
		}

		lines.push(theme.fg("borderMuted", "─".repeat(safeWidth)));
		return lines;
	}

	private rule(width: number): string {
		const label = ` compaction ${this.options.tokensBefore.toLocaleString()} tok `;
		if (visibleWidth(label) + 2 >= width) {
			return theme.fg("borderAccent", truncateToWidth(label, width, ""));
		}
		const right = "─".repeat(Math.max(0, width - visibleWidth(label) - 1));
		return theme.fg("borderAccent", "─") + theme.fg("customMessageLabel", label) + theme.fg("borderAccent", right);
	}

	private reasonText(): string {
		switch (this.options.reason) {
			case "manual":
				return "manual compaction";
			case "threshold":
				return "context threshold reached";
			case "overflow":
				return "context overflow recovery";
			default:
				return "engine compaction";
		}
	}

	private collapsedTranscriptText(): string {
		if (this.options.preCompactionTurns !== undefined) {
			return `${this.options.preCompactionTurns.toLocaleString()} turns`;
		}
		return `${this.options.tokensBefore.toLocaleString()} tokens`;
	}

	private quote(summary: string): string {
		return stripAnsi(summary)
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
	}
}
