import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PRIME_BUTTERFLY_LOGO } from "../../../themes/prime-logo.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";

interface PrimeOnboardingSplashOptions {
	getRows?: () => number;
}

const LOGO_LINES = PRIME_BUTTERFLY_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const PANEL_WIDTH = 76;
const PANEL_PADDING_X = 3;
const BUTTON_LABEL = "Continue with Prime Intellect";

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
		const contentLines = ["", ...this.renderLogoLines(safeWidth), "", ...this.renderPanel(safeWidth)];

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

	private formatLoginButton(): string {
		return theme.bg("selectedBg", `  ${theme.bold(theme.fg("text", BUTTON_LABEL))}  `);
	}

	private renderPanel(width: number): string[] {
		const panelWidth = Math.min(PANEL_WIDTH, width);
		const left = Math.max(0, Math.floor((width - panelWidth) / 2));
		const headline = theme.bold(theme.fg("text", "Prime Agent"));
		const subhead = theme.fg("muted", "A coding agent connected to Prime Intellect.");
		const detail = theme.fg("muted", "Use one account for managed inference, model access, and usage.");
		const hints = theme.fg(
			"muted",
			`${keyHint("tui.select.confirm", "continue")}  ${keyHint("tui.select.cancel", "cancel")}`,
		);

		return [
			this.surfaceLine("", panelWidth, left, width),
			this.surfaceLine(this.centerWithin(headline, this.panelInnerWidth(panelWidth)), panelWidth, left, width),
			this.surfaceLine(this.centerWithin(subhead, this.panelInnerWidth(panelWidth)), panelWidth, left, width),
			this.surfaceLine("", panelWidth, left, width),
			this.surfaceLine(
				this.centerWithin(this.formatLoginButton(), this.panelInnerWidth(panelWidth)),
				panelWidth,
				left,
				width,
			),
			this.surfaceLine("", panelWidth, left, width),
			this.surfaceLine(this.centerWithin(detail, this.panelInnerWidth(panelWidth)), panelWidth, left, width),
			this.surfaceLine(this.centerWithin(hints, this.panelInnerWidth(panelWidth)), panelWidth, left, width),
			this.surfaceLine("", panelWidth, left, width),
		];
	}

	private panelInnerWidth(panelWidth: number): number {
		return Math.max(1, panelWidth - PANEL_PADDING_X * 2);
	}

	private surfaceLine(text: string, panelWidth: number, left: number, width: number): string {
		const innerWidth = this.panelInnerWidth(panelWidth);
		const content = truncateToWidth(text, innerWidth, "");
		const rightPadding = Math.max(0, innerWidth - visibleWidth(content));
		const line = " ".repeat(PANEL_PADDING_X) + content + " ".repeat(rightPadding) + " ".repeat(PANEL_PADDING_X);
		const surface = theme.getEditorBackgroundColor()?.(line) ?? line;
		return this.place(surface, width, left);
	}

	private centerWithin(text: string, width: number): string {
		const content = truncateToWidth(text, width, "");
		const left = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
		const right = Math.max(0, width - left - visibleWidth(content));
		return " ".repeat(left) + content + " ".repeat(right);
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
