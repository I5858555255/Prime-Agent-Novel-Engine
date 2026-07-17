import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

const HIGHLIGHT_WIDTH = 6;

export const FEATURE_HINT_ANIMATION_INTERVAL_MS = 120;

export class FeatureHintComponent implements Component {
	private frame = 0;

	constructor(private readonly text: string) {}

	advance(): void {
		this.frame++;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const paddingX = width > 2 ? 1 : 0;
		const availableWidth = Math.max(1, width - paddingX * 2);
		const displayText = truncateToWidth(`Hint: ${this.text}`, availableWidth);
		const characters = Array.from(displayText);
		const highlightWidth = Math.min(HIGHLIGHT_WIDTH, characters.length);
		const maxStart = Math.max(0, characters.length - highlightWidth);
		const cycleLength = maxStart * 2;
		const phase = cycleLength === 0 ? 0 : this.frame % cycleLength;
		const highlightStart = phase <= maxStart ? phase : cycleLength - phase;
		const highlightEnd = highlightStart + highlightWidth;
		const before = characters.slice(0, highlightStart).join("");
		const highlight = characters.slice(highlightStart, highlightEnd).join("");
		const after = characters.slice(highlightEnd).join("");
		const styledText = theme.fg("dim", before) + theme.fg("muted", highlight) + theme.fg("dim", after);
		const line = `${" ".repeat(paddingX)}${styledText}`;

		return [line + " ".repeat(Math.max(0, width - visibleWidth(line)))];
	}
}
