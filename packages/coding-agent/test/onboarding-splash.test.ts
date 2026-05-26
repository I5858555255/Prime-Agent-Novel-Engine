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

	it("renders a spaced centered onboarding flow with the butterfly logo and login choices", () => {
		const component = new OnboardingSplashComponent(
			() => {},
			() => {},
			{ getRows: () => 36 },
		);
		const lines = component.render(100);
		const output = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(36);
		expect(output).toContain("Prime Agent");
		expect(output).not.toContain("Welcome to Prime Agent");
		expect(output).not.toContain("Let's connect your account and choose a model.");
		expect(output).toContain("Sign in or add a key to choose a model.");
		expect(output).toContain("Use Prime Intellect");
		expect(output).toContain("Use a subscription");
		expect(output).toContain("Use an API key");
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

		const primeLine = rendered.find((line) => line.includes("Use Prime Intellect")) ?? "";
		const subscriptionLine = rendered.find((line) => line.includes("Use a subscription")) ?? "";
		const apiKeyLine = rendered.find((line) => line.includes("Use an API key")) ?? "";

		expect(primeLine.indexOf("Use Prime Intellect")).toBe(subscriptionLine.indexOf("Use a subscription"));
		expect(subscriptionLine.indexOf("Use a subscription")).toBe(apiKeyLine.indexOf("Use an API key"));
		expect(primeLine).toContain("  managed inference");
		expect(subscriptionLine.indexOf("provider sign-in")).toBe(apiKeyLine.indexOf("bring your own key"));
		expect(rendered.some((line) => line.includes("─".repeat(10)))).toBe(false);

		const primeIndex = rendered.findIndex((line) => line.includes("Use Prime Intellect"));
		const subscriptionIndex = rendered.findIndex((line) => line.includes("Use a subscription"));
		const apiKeyIndex = rendered.findIndex((line) => line.includes("Use an API key"));
		expect(rendered[primeIndex + 1]?.trim()).toBe("");
		expect(rendered[subscriptionIndex + 1]?.trim()).toBe("");
		expect(subscriptionIndex - primeIndex).toBe(2);
		expect(apiKeyIndex - subscriptionIndex).toBe(2);
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
