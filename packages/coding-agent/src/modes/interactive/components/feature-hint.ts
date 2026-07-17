import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

const SHIMMER_RADIUS = 4;
const SHIMMER_CORE_RADIUS = 1;
const SHIMMER_SPACING = 28;

export const FEATURE_HINT_ANIMATION_INTERVAL_MS = 24;

type ShimmerColor = "dim" | "muted" | "text";

function shimmerColor(index: number, length: number, frame: number): ShimmerColor {
	const highlightCount = Math.min(3, Math.max(1, Math.ceil(length / SHIMMER_SPACING)));
	const phase = frame % length;
	let nearestDistance = length;

	for (let highlight = 0; highlight < highlightCount; highlight++) {
		const center = (phase + (highlight * length) / highlightCount) % length;
		const distance = Math.abs(index - center);
		nearestDistance = Math.min(nearestDistance, distance, length - distance);
	}

	if (nearestDistance <= SHIMMER_CORE_RADIUS) return "text";
	if (nearestDistance <= SHIMMER_RADIUS) return "muted";
	return "dim";
}

function renderShimmer(characters: string[], frame: number): string {
	if (characters.length === 0) return "";

	let output = "";
	let run = "";
	let runColor = shimmerColor(0, characters.length, frame);

	for (let index = 0; index < characters.length; index++) {
		const color = shimmerColor(index, characters.length, frame);
		if (color !== runColor) {
			output += theme.fg(runColor, run);
			run = "";
			runColor = color;
		}
		run += characters[index]!;
	}

	return output + theme.fg(runColor, run);
}

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
		const line = `${" ".repeat(paddingX)}${renderShimmer(characters, this.frame)}`;

		return [line + " ".repeat(Math.max(0, width - visibleWidth(line))), " ".repeat(width)];
	}
}
