import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type OnboardingAuthChoice,
	OnboardingSplashComponent,
} from "../src/modes/interactive/components/onboarding-splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { PRIME_LOGO_MEDIUM } from "../src/themes/prime-logo.js";

describe("OnboardingSplashComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the centered welcome flow with the medium butterfly logo and login choices", () => {
		const component = new OnboardingSplashComponent(
			() => {},
			() => {},
		);
		const lines = component.render(100);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("Prime Agent");
		expect(output).toContain("Prime");
		expect(output).toContain("Subscription");
		expect(output).toContain("API key");
		expect(output).toContain(PRIME_LOGO_MEDIUM.split("\n")[0].trim());
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	});

	it("selects the highlighted login option", () => {
		let selected: OnboardingAuthChoice | undefined;
		const component = new OnboardingSplashComponent(
			(choice) => {
				selected = choice;
			},
			() => {},
		);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");

		expect(selected).toBe("api_key");
	});
});
