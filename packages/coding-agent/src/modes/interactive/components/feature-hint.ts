import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

const SHIMMER_RADIUS = 4;
const SHIMMER_CORE_RADIUS = 1;

export const FEATURE_HINT_ANIMATION_INTERVAL_MS = 24;

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
		const maxCenter = Math.max(0, characters.length - 1);
		const cycleLength = maxCenter * 2;
		const phase = cycleLength === 0 ? 0 : this.frame % cycleLength;
		const center = phase <= maxCenter ? phase : cycleLength - phase;
		const shimmerStart = Math.max(0, center - SHIMMER_RADIUS);
		const coreStart = Math.max(shimmerStart, center - SHIMMER_CORE_RADIUS);
		const coreEnd = Math.min(characters.length, center + SHIMMER_CORE_RADIUS + 1);
		const shimmerEnd = Math.min(characters.length, center + SHIMMER_RADIUS + 1);
		const styledText =
			theme.fg("dim", characters.slice(0, shimmerStart).join("")) +
			theme.fg("muted", characters.slice(shimmerStart, coreStart).join("")) +
			theme.fg("text", characters.slice(coreStart, coreEnd).join("")) +
			theme.fg("muted", characters.slice(coreEnd, shimmerEnd).join("")) +
			theme.fg("dim", characters.slice(shimmerEnd).join(""));
		const line = `${" ".repeat(paddingX)}${styledText}`;

		return [line + " ".repeat(Math.max(0, width - visibleWidth(line))), " ".repeat(width)];
	}
}
