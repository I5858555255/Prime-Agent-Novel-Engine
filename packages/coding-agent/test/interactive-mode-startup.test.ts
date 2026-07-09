import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { BrandSplashHeader, InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("InteractiveMode startup hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders supported commands and the configured shortcut hint", () => {
		const mode = { childAgentPanelMode: undefined };
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const metadata = Reflect.get(InteractiveMode.prototype, "getStartupMetadata").call(mode);
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
			undefined,
			{
				getExtraMetadata: () => metadata,
				getStartHint: () => 'Try "refactor <filepath>"',
			},
		);

		const output = stripAnsi(header.render(120).join("\n"));

		expect(output).toContain("/model or /tree");
		expect(output).toContain("? for shortcuts · / for commands");
		expect(output).toContain('Try "refactor <filepath>"');
	});
});
