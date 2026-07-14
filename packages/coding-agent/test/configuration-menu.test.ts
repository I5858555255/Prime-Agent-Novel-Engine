import { type KeyId, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ConfigurationMenuComponent } from "../src/modes/interactive/components/configuration-menu.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ConfigurationMenuComponent", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("uses one three-tab menu and keeps each tab body mounted", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "Faux One", reasoning: true }],
		});
		harnesses.push(harness);
		const requestRender = vi.fn();
		const selectProvider = vi.fn();
		const model = harness.getModel("faux-1")!;
		const menu = new ConfigurationMenuComponent({
			initialTab: "providers",
			tui: createFakeTui(),
			authStorage: harness.session.modelRegistry.authStorage,
			providerOptions: [
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{
					id: "serper",
					name: "Serper (web search)",
					authType: "api_key",
					category: "service",
				},
			],
			modelRegistry: harness.session.modelRegistry,
			currentModel: model,
			scopedModels: [],
			availableModels: [model],
			requestRender,
			onSelectProvider: selectProvider,
			onSelectMcpConnection: vi.fn(),
			onSelectModel: vi.fn(),
			onCancel: vi.fn(),
		});

		let output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("Providers");
		expect(output).toContain("Models");
		expect(output).toContain("MCP Connections");
		expect(output).toContain("Anthropic");
		expect(output).not.toContain("Serper (web search)");

		menu.handleInput("a");
		menu.setActiveTab("models");
		output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("Faux One");

		menu.setActiveTab("providers");
		output = stripAnsi(menu.render(120).join("\n"));
		expect(menu.getSearchValue("providers")).toBe("a");
		expect(output).toContain("Anthropic");
		expect(requestRender).toHaveBeenCalled();

		menu.handleInput("\r");
		expect(selectProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "anthropic" }));

		menu.setActiveTab("mcp-connections");
		output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
	});

	it("switches tabs with configured left and right keys when search is empty", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "Faux One", reasoning: true }],
		});
		harnesses.push(harness);
		setKeybindings(
			new KeybindingsManager({
				"tui.editor.cursorLeft": "ctrl+y" as KeyId,
				"tui.editor.cursorRight": "ctrl+x" as KeyId,
			}),
		);
		const model = harness.getModel("faux-1")!;
		const menu = new ConfigurationMenuComponent({
			initialTab: "providers",
			tui: createFakeTui(),
			authStorage: harness.session.modelRegistry.authStorage,
			providerOptions: [
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{ id: "serper", name: "Serper", authType: "api_key", category: "service" },
			],
			modelRegistry: harness.session.modelRegistry,
			currentModel: model,
			scopedModels: [],
			availableModels: [model],
			requestRender: () => {},
			onSelectProvider: () => {},
			onSelectMcpConnection: () => {},
			onSelectModel: () => {},
			onCancel: () => {},
		});

		menu.handleInput("\x18");
		expect(menu.getActiveTab()).toBe("models");
		menu.handleInput("\x18");
		expect(menu.getActiveTab()).toBe("mcp-connections");
		menu.handleInput("\x19");
		expect(menu.getActiveTab()).toBe("models");
	});
});
