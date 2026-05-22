import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type OnboardingAuthChoice,
	OnboardingSplashComponent,
} from "../src/modes/interactive/components/onboarding-splash.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { PRIME_BUTTERFLY_LOGO } from "../src/themes/prime-logo.js";

describe("OnboardingSplashComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders the centered welcome flow with the butterfly logo and login choices", () => {
		const component = new OnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);
		const lines = component.render(100);
		const output = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(36);
		expect(output).toContain("Prime Agent");
		expect(output).toContain("Prime Intellect");
		expect(output).toContain("Subscription");
		expect(output).toContain("API key");
		expect(output).toContain(PRIME_BUTTERFLY_LOGO.split("\n")[0].trim());
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
	});

	it("preserves logo canvas alignment and aligns auth choices as a text block", () => {
		const component = new OnboardingSplashComponent(
			() => {},
			() => {},
		);
		const rendered = stripAnsi(component.render(100).join("\n")).split("\n");
		const originalLogoLines = PRIME_BUTTERFLY_LOGO.split("\n");
		const logoStart = rendered.findIndex((line) => line.includes(originalLogoLines[0]?.trim() ?? ""));
		const firstLogoIndent = rendered[logoStart]?.search(/\S/) ?? -1;
		const secondLogoIndent = rendered[logoStart + 1]?.search(/\S/) ?? -1;
		const originalFirstIndent = originalLogoLines[0]?.search(/\S/) ?? -1;
		const originalSecondIndent = originalLogoLines[1]?.search(/\S/) ?? -1;

		expect(firstLogoIndent - secondLogoIndent).toBe(originalFirstIndent - originalSecondIndent);

		const primeLine = rendered.find((line) => line.includes("Prime Intellect")) ?? "";
		const subscriptionLine = rendered.find((line) => line.includes("Subscription")) ?? "";
		const apiKeyLine = rendered.find((line) => line.includes("API key")) ?? "";

		expect(primeLine.indexOf("Prime Intellect")).toBe(subscriptionLine.indexOf("Subscription"));
		expect(subscriptionLine.indexOf("Subscription")).toBe(apiKeyLine.indexOf("API key"));
		expect(primeLine.indexOf("managed inference login")).toBe(subscriptionLine.indexOf("browser sign-in"));
		expect(subscriptionLine.indexOf("browser sign-in")).toBe(apiKeyLine.indexOf("paste a provider key"));
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
