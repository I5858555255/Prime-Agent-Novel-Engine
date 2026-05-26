import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PRIME_BUTTERFLY_LOGO } from "../../../themes/prime-logo.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";

interface PrimeOnboardingSplashOptions {
	getRows?: () => number;
}

const LOGO_LINES = PRIME_BUTTERFLY_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const BRAND_COLUMN_GAP = "    ";
const ACTION_LABEL = "Log in with Prime Intellect";
const ACTION_DESCRIPTION = "required for first-time setup";

export class PrimeOnboardingSplashComponent implements Component {
	constructor(
		private readonly onSelect: () => void,
		private readonly onCancel: () => void,
		private readonly options: PrimeOnboardingSplashOptions = {},
	) {}

	invalidate(): void {
		// Render output is derived from current theme.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentLines = [
			"",
			...this.renderBrandLines(safeWidth),
			"",
			"",
			this.center(
				`${keyHint("tui.select.confirm", "continue")}  ${keyHint("tui.select.cancel", "cancel")}`,
				safeWidth,
			),
		];

		return this.withVerticalSpace(contentLines, safeWidth);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSelect();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	private renderBrandLines(width: number): string[] {
		const textLines = this.formatTextLines();
		const textWidth = textLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		const horizontalWidth = LOGO_WIDTH + visibleWidth(BRAND_COLUMN_GAP) + textWidth;
		if (horizontalWidth > width) {
			return [
				...this.renderLogoLines(width),
				"",
				...textLines.map((line) => (line === "" ? this.blank(width) : this.center(line, width))),
			];
		}

		const left = Math.max(0, Math.floor((width - horizontalWidth) / 2));
		const textTopPadding = Math.max(0, Math.floor((LOGO_LINES.length - textLines.length) / 2));
		return LOGO_LINES.map((logoLine, index) => {
			const paddedLogo = logoLine + " ".repeat(Math.max(0, LOGO_WIDTH - visibleWidth(logoLine)));
			const textLine = textLines[index - textTopPadding] ?? "";
			const line = theme.fg("text", paddedLogo) + BRAND_COLUMN_GAP + textLine;
			return this.place(line, width, left);
		});
	}

	private formatTextLines(): string[] {
		const actionLabel = theme.bold(theme.fg("text", ACTION_LABEL));
		return [
			theme.bold(theme.fg("text", "Prime Agent")),
			theme.fg("muted", "Start with your Prime Intellect account."),
			"",
			`${theme.fg("accent", "→ ")}${actionLabel}   ${theme.fg("muted", ACTION_DESCRIPTION)}`,
		];
	}

	private renderLogoLines(width: number): string[] {
		const logoWidth = Math.min(LOGO_WIDTH, width);
		const left = Math.max(0, Math.floor((width - logoWidth) / 2));
		return LOGO_LINES.map((line) => {
			const paddedLine = line + " ".repeat(Math.max(0, LOGO_WIDTH - visibleWidth(line)));
			const content = theme.fg("text", truncateToWidth(paddedLine, logoWidth, ""));
			return this.place(content, width, left);
		});
	}

	private center(text: string, width: number): string {
		const content = truncateToWidth(text, width, "");
		const padding = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
		return this.place(content, width, padding);
	}

	private place(text: string, width: number, left: number): string {
		const safeLeft = Math.max(0, Math.min(left, width));
		const contentWidth = Math.max(0, width - safeLeft);
		const content = truncateToWidth(text, contentWidth, "");
		const right = Math.max(0, width - safeLeft - visibleWidth(content));
		return " ".repeat(safeLeft) + content + " ".repeat(right);
	}

	private blank(width: number): string {
		return " ".repeat(width);
	}

	private withVerticalSpace(contentLines: string[], width: number): string[] {
		const requestedRows = this.options.getRows?.();
		const targetRows =
			requestedRows && Number.isFinite(requestedRows)
				? Math.max(contentLines.length, Math.floor(requestedRows))
				: contentLines.length;
		const topPadding = Math.max(0, Math.floor((targetRows - contentLines.length) / 2));
		const bottomPadding = Math.max(0, targetRows - contentLines.length - topPadding);
		return [
			...Array.from({ length: topPadding }, () => this.blank(width)),
			...contentLines.map((line) => this.place(line, width, 0)),
			...Array.from({ length: bottomPadding }, () => this.blank(width)),
		];
	}
}
