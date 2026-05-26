import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PrimeOnboardingSplashComponent } from "../src/modes/interactive/components/prime-onboarding-splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { PRIME_BUTTERFLY_LOGO } from "../src/themes/prime-logo.js";

describe("PrimeOnboardingSplashComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders Prime Intellect as the only first-run onboarding action", () => {
		const component = new PrimeOnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);
		const lines = component.render(100);
		const output = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(36);
		expect(output).toContain("Prime Agent");
		expect(output).toContain("Prime Intellect");
		expect(output).toContain("Login");
		expect(output).not.toContain("required for first-time setup");
		expect(output).not.toContain("Start with your Prime Intellect account.");
		expect(output).not.toContain("Log in with Prime Intellect");
		expect(output).not.toContain("→");
		expect(output).not.toContain("Use a subscription");
		expect(output).not.toContain("Use an API key");
		expect(output).toContain(PRIME_BUTTERFLY_LOGO.split("\n")[0].trim());
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	});

	it("starts Prime login on confirm", () => {
		let selected = false;
		const component = new PrimeOnboardingSplashComponent(
			() => {
				selected = true;
			},
			() => {},
		);

		component.handleInput("\r");

		expect(selected).toBe(true);
	});
});
