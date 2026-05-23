import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PRIME_BUTTERFLY_LOGO } from "../../../themes/prime-logo.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export type OnboardingAuthChoice = "prime" | "subscription" | "api_key";

interface OnboardingOption {
	id: OnboardingAuthChoice;
	label: string;
	description: string;
}

interface OnboardingSplashOptions {
	getRows?: () => number;
}

const ONBOARDING_OPTIONS: readonly OnboardingOption[] = [
	{ id: "prime", label: "Use Prime Intellect", description: "managed inference with your Prime account" },
	{ id: "subscription", label: "Use a subscription", description: "sign in through a supported provider" },
	{ id: "api_key", label: "Use an API key", description: "paste a provider key" },
];

const LOGO_LINES = PRIME_BUTTERFLY_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const OPTION_LABEL_WIDTH = ONBOARDING_OPTIONS.reduce((max, option) => Math.max(max, visibleWidth(option.label)), 0);
const OPTION_COLUMN_GAP = "  ";

export class OnboardingSplashComponent implements Component {
	private selectedIndex = 0;

	constructor(
		private readonly onSelect: (choice: OnboardingAuthChoice) => void,
		private readonly onCancel: () => void,
		private readonly options: OnboardingSplashOptions = {},
	) {}

	invalidate(): void {
		// Render output is derived from current theme and selection state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentLines: string[] = [];

		contentLines.push("");
		for (const line of this.renderLogoLines(safeWidth)) {
			contentLines.push(line);
		}
		contentLines.push("");
		contentLines.push(this.center(theme.bold(theme.fg("text", "Welcome to Prime Agent")), safeWidth));
		contentLines.push(this.center(theme.fg("muted", "Let's connect your account and choose a model."), safeWidth));
		contentLines.push("");

		for (const optionLine of this.renderOptionLines(safeWidth)) {
			contentLines.push(optionLine);
		}

		contentLines.push("");
		contentLines.push(
			this.center(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				safeWidth,
			),
		);

		return this.withVerticalSpace(contentLines, safeWidth);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? ONBOARDING_OPTIONS.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = (this.selectedIndex + 1) % ONBOARDING_OPTIONS.length;
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = ONBOARDING_OPTIONS[this.selectedIndex];
			if (selected) {
				this.onSelect(selected.id);
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	private formatOption(option: OnboardingOption, selected: boolean): string {
		const marker = selected ? "→ " : "  ";
		const label = option.label.padEnd(OPTION_LABEL_WIDTH) + OPTION_COLUMN_GAP;
		if (selected) {
			return (
				theme.fg("warning", marker) + theme.bold(theme.fg("text", label)) + theme.fg("muted", option.description)
			);
		}
		return theme.fg("dim", marker) + theme.fg("text", label) + theme.fg("muted", option.description);
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

	private renderOptionLines(width: number): string[] {
		const optionLines = ONBOARDING_OPTIONS.map((option, index) =>
			this.formatOption(option, index === this.selectedIndex),
		);
		const optionWidth = Math.min(
			width,
			optionLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0),
		);
		const left = Math.max(0, Math.floor((width - optionWidth) / 2));
		return optionLines.map((line) => this.place(line, width, left));
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
