import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";

export interface CollapsibleErrorOptions {
	text: string;
	summary?: string;
	expanded?: boolean;
	forceCollapse?: boolean;
	paddingX?: number;
}

export function normalizeErrorDetails(text: string): string {
	return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

export function summarizeErrorDetails(text: string): string {
	const normalized = normalizeErrorDetails(text);
	const lines = normalized
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) {
		return "Error";
	}
	if (lines[0]?.startsWith("Traceback ")) {
		return lines.at(-1) ?? "Error";
	}
	return lines[0] ?? "Error";
}

export function shouldCollapseErrorDetails(text: string): boolean {
	return normalizeErrorDetails(text).split("\n").length > 1;
}

export class CollapsibleErrorComponent implements Component {
	private expanded: boolean;

	constructor(private readonly options: CollapsibleErrorOptions) {
		this.expanded = options.expanded ?? false;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		// Render output is derived from constructor options and expansion state.
	}

	render(width: number): string[] {
		const text = normalizeErrorDetails(this.options.text);
		if (!text) {
			return [];
		}

		const collapsible = this.options.forceCollapse ?? shouldCollapseErrorDetails(text);
		if (!collapsible || this.expanded) {
			return this.renderText(text, width);
		}

		const summary = normalizeErrorDetails(this.options.summary ?? summarizeErrorDetails(text));
		const inlineHint = `${summary} ${theme.fg("dim", "·")} ${keyHint("app.tools.expand", "to expand")}`;
		return this.renderText(inlineHint, width, "muted");
	}

	private renderText(text: string, width: number, color: "error" | "muted" = "error"): string[] {
		const safeWidth = Math.max(1, width);
		const paddingX = this.options.paddingX ?? 1;
		const contentWidth = Math.max(1, safeWidth - paddingX);
		const prefix = " ".repeat(paddingX);
		const lines: string[] = [];
		for (const rawLine of text.split("\n")) {
			const styled = theme.fg(color, rawLine || " ");
			const wrapped = wrapTextWithAnsi(styled, contentWidth);
			for (const line of wrapped.length > 0 ? wrapped : [""]) {
				const padded = `${prefix}${line}`;
				lines.push(truncateToWidth(padded, safeWidth, ""));
			}
		}
		return lines.map((line) => line + " ".repeat(Math.max(0, safeWidth - visibleWidth(line))));
	}
}
