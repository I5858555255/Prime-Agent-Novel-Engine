import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PRIME_LOGO_MEDIUM } from "../../../themes/prime-logo.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export type OnboardingAuthChoice = "prime" | "subscription" | "api_key";

interface OnboardingOption {
	id: OnboardingAuthChoice;
	label: string;
	description: string;
}

const ONBOARDING_OPTIONS: readonly OnboardingOption[] = [
	{ id: "prime", label: "Prime", description: "Prime Inference" },
	{ id: "subscription", label: "Subscription", description: "browser sign-in" },
	{ id: "api_key", label: "API key", description: "paste a provider key" },
];

const LOGO_LINES = PRIME_LOGO_MEDIUM.split("\n");

export class OnboardingSplashComponent implements Component {
	private selectedIndex = 0;

	constructor(
		private readonly onSelect: (choice: OnboardingAuthChoice) => void,
		private readonly onCancel: () => void,
	) {}

	invalidate(): void {
		// Render output is derived from current theme and selection state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];

		lines.push("");
		for (const line of LOGO_LINES) {
			lines.push(this.center(theme.fg("text", line), safeWidth));
		}
		lines.push("");
		lines.push(this.center(theme.bold(theme.fg("accent", "Prime Agent")), safeWidth));
		lines.push(this.center(theme.fg("muted", "Sign in to choose a model and start using the agent."), safeWidth));
		lines.push("");

		for (const [index, option] of ONBOARDING_OPTIONS.entries()) {
			lines.push(this.center(this.formatOption(option, index === this.selectedIndex), safeWidth));
		}

		lines.push("");
		lines.push(
			this.center(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				safeWidth,
			),
		);

		return lines;
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
		const label = option.label.padEnd(14);
		if (selected) {
			return theme.fg("accent", marker + label) + theme.fg("text", option.description);
		}
		return theme.fg("muted", marker + label) + theme.fg("muted", option.description);
	}

	private center(text: string, width: number): string {
		const content = truncateToWidth(text, width, "");
		const padding = Math.max(0, Math.floor((width - visibleWidth(content)) / 2));
		return " ".repeat(padding) + content;
	}
}
