import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { BrandSplashHeader, InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

describe("InteractiveMode startup hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function createMode(sessionHasMessages = false, returnToAgentsView = false) {
		const mode = {
			childAgentPanelMode: undefined,
			sessionHasMessages,
			options: { returnToAgentsView },
			editor: { getText: () => "" },
			connectionState: {
				model: { name: "test-model", reasoning: true },
				thinkingLevel: "high",
			},
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("renders compact new-chat guidance and the configured shortcut hint", () => {
		const mode = createMode();
		const metadata = Reflect.get(InteractiveMode.prototype, "getStartupMetadata").call(mode);
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
			undefined,
			{
				getExtraMetadata: () => metadata,
				getStartHint: () => 'Try "refactor @<filepath>"',
			},
		);

		const output = stripAnsi(header.render(120).join("\n"));

		expect(output).toContain("! shell · / commands");
		expect(output).toContain("@ file paths");
		expect(output).toContain("? or /hotkeys");
		expect(output).toContain('Try "refactor @<filepath>"');
	});

	it("places the fresh-chat shortcut hint after the model and effort", () => {
		const mode = createMode();
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("test-model • high  ? or /hotkeys");
	});

	it("places the Agents View hint before the model and fresh-chat help", () => {
		const mode = createMode(false, true);
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(stripAnsi(label)).toBe("← agents view  test-model • high  ? or /hotkeys");
	});

	it("hides startup shortcut guidance for chats with history", () => {
		const mode = createMode(true);
		const metadata = Reflect.get(InteractiveMode.prototype, "getStartupMetadata").call(mode);
		const label = Reflect.get(InteractiveMode.prototype, "getTrayLocationLabel").call(mode);

		expect(metadata).toEqual([]);
		expect(stripAnsi(label)).toBe("test-model • high");
	});

	it("keeps the shortcut guide compact", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getHotkeysGuide").call(createMode());

		expect(guide).toContain("`!` shell mode · `/` commands · `@` file paths");
		expect(guide).toContain("stash prompt");
		expect(guide).toContain("`/hotkeys` show this guide");
		expect(guide).not.toContain("**Navigation**");
		expect(guide).not.toContain("**Extensions**");
	});

	it("renders shortcut help ephemerally without appending to chat history", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand").call(mode);
		Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand").call(mode);

		expect(chatContainer.children).toHaveLength(0);
		expect(shortcutGuideContainer.children).toHaveLength(2);

		Reflect.get(InteractiveMode.prototype, "clearHotkeysGuide").call(mode);

		expect(shortcutGuideContainer.children).toHaveLength(0);
	});
});
