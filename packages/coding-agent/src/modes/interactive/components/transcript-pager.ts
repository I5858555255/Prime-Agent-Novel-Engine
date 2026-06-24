import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { shouldTreatAsBack } from "./modal-back.js";

interface TerminalSize {
	get columns(): number;
	get rows(): number;
}

/**
 * Full-screen scrollable pager for the expanded transcript. Renders a header,
 * a scrollable content window, and a footer with the scroll position. Content
 * lines are supplied by `getLines(width)` and recomputed when the width changes
 * (e.g. on resize) so wrapping stays correct.
 */
export class TranscriptPager implements Component, Focusable {
	focused = false;
	private scrollOffset = 0;
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private readonly title: string,
		private readonly getLines: (width: number) => string[],
		private readonly size: TerminalSize,
		private readonly onClose: () => void,
	) {}

	invalidate(): void {
		this.cachedWidth = -1;
	}

	private contentLines(width: number): string[] {
		if (width !== this.cachedWidth) {
			this.cachedLines = this.getLines(width);
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	// Content rows available between the header and footer.
	private contentHeight(): number {
		return Math.max(1, this.size.rows - 2);
	}

	private maxScroll(width: number): number {
		return Math.max(0, this.contentLines(width).length - this.contentHeight());
	}

	private clampScroll(width: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScroll(width)));
	}

	handleInput(data: string): void {
		const width = this.size.columns;
		const page = this.contentHeight();
		if (matchesKey(data, "esc") || shouldTreatAsBack(data) || matchesKey(data, "ctrl+t") || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset -= 1;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset += 1;
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) {
			this.scrollOffset -= page;
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f") || matchesKey(data, "space")) {
			this.scrollOffset += page;
		} else if (matchesKey(data, "ctrl+u")) {
			this.scrollOffset -= Math.max(1, Math.floor(page / 2));
		} else if (matchesKey(data, "ctrl+d")) {
			this.scrollOffset += Math.max(1, Math.floor(page / 2));
		} else if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.scrollOffset = 0;
		} else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
			this.scrollOffset = this.maxScroll(width);
		}
		this.clampScroll(width);
	}

	render(width: number): string[] {
		this.clampScroll(width);
		const lines = this.contentLines(width);
		const contentHeight = this.contentHeight();
		const out: string[] = [];

		out.push(truncateToWidth(theme.fg("muted", this.title), width, "…"));

		const window = lines.slice(this.scrollOffset, this.scrollOffset + contentHeight);
		for (const line of window) {
			out.push(line);
		}
		for (let i = window.length; i < contentHeight; i++) {
			out.push("");
		}

		out.push(this.footer(width));
		return out;
	}

	private footer(width: number): string {
		const max = this.maxScroll(width);
		const pct = max === 0 ? 100 : Math.round((this.scrollOffset / max) * 100);
		const left = `${pct}%`;
		const right = "↑↓ scroll · esc close";
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return theme.fg("dim", `${left}${" ".repeat(gap)}${right}`);
	}
}
