import { type AutocompleteProvider, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import type { AgentConnectionModel, AgentConnectionModelCatalog } from "../../../src/modes/agent-connection/types.js";
import { getAgentsViewModelArgumentCompletions } from "../../../src/modes/agents-view/agents-view-mode.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { getModelArgumentCompletions } from "../../../src/modes/model-autocomplete.js";
import { createHarness, type Harness } from "../harness.js";

interface ConnectionAuthRefreshHarness {
	agentConnection: { getModelCatalog(): Promise<AgentConnectionModelCatalog> };
	connectionModels: AgentConnectionModel[];
	connectionModelCatalog: AgentConnectionModel[];
	connectionConfiguredProviders: Set<string>;
	connectionModelsFetchedAt: number;
	connectionModelsRefreshVersion: number;
	connectionModelsRefreshInFlight: { version: number; promise: Promise<AgentConnectionModel[]> } | undefined;
	invalidateConnectionModels(): void;
	applyConnectionModelCatalog(catalog: AgentConnectionModelCatalog): void;
	getConnectionAvailableModels(): Promise<AgentConnectionModel[]>;
	refreshConnectionModelsAfterAuthChange(): Promise<void>;
}

interface InteractiveAutocompleteHarness {
	connectionState: { scopedModels: Array<{ model: AgentConnectionModel }> };
	connectionModelCatalog: AgentConnectionModel[];
	connectionCommands: [];
	skillCommands: Map<string, string>;
	uiServices: { settingsManager: { getEnableSkillCommands(): boolean } };
	bindLocalSessionExtensions: boolean;
	fdPath: undefined;
	currentModelSupportsFastMode(): boolean;
	getAvailableThinkingLevels(): [];
	getCurrentCwd(): string;
	createBaseAutocompleteProvider(): AutocompleteProvider;
}

describe("ENG-4575 model authentication", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	test("shows unauthenticated public models after authenticated providers", async () => {
		const harness = await createHarness({
			models: [{ id: "base", name: "Base", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("base")!;
		const unauthenticated = { ...base, provider: "a-unauthenticated", id: "requires-auth" };
		const authenticated = { ...base, provider: "z-authenticated", id: "available" };
		let selectedProvider: string | undefined;
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			unauthenticated,
			harness.session.modelRegistry,
			[],
			(model) => {
				selectedProvider = model.provider;
			},
			() => {},
			undefined,
			{
				availableModels: [unauthenticated, authenticated],
				configuredProviders: new Set([authenticated.provider]),
				recentModels: [`${unauthenticated.provider}/${unauthenticated.id}`],
			},
		);

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const authenticatedRow = lines.findIndex((line) => line.includes("available"));
		const unauthenticatedRow = lines.findIndex((line) => line.includes("requires-auth"));
		expect(authenticatedRow).toBeGreaterThanOrEqual(0);
		expect(authenticatedRow).toBeLessThan(unauthenticatedRow);
		expect(lines[unauthenticatedRow]).toContain("current · sign in");

		selector.handleInput("\r");
		expect(selectedProvider).toBe(unauthenticated.provider);
	});

	test("refetches configured providers after authentication changes", async () => {
		const harness = await createHarness({ models: [{ id: "base", name: "Base", reasoning: true }] });
		harnesses.push(harness);
		const model = { ...harness.getModel("base")!, provider: "openai" } as AgentConnectionModel;
		const getModelCatalog = vi.fn(async () => ({ models: [model], configuredProviders: [] }));
		const fakeThis = Object.create(InteractiveMode.prototype) as ConnectionAuthRefreshHarness;
		fakeThis.agentConnection = { getModelCatalog };
		fakeThis.connectionModels = [model];
		fakeThis.connectionModelCatalog = [model];
		fakeThis.connectionConfiguredProviders = new Set([model.provider]);
		fakeThis.connectionModelsFetchedAt = Date.now();
		fakeThis.connectionModelsRefreshVersion = 0;
		fakeThis.connectionModelsRefreshInFlight = undefined;

		await fakeThis.refreshConnectionModelsAfterAuthChange();

		expect(getModelCatalog).toHaveBeenCalledOnce();
		expect(fakeThis.connectionConfiguredProviders).toEqual(new Set());
		expect(fakeThis.connectionModels).toEqual([]);
		expect(fakeThis.connectionModelCatalog).toEqual([model]);
	});

	test("uses the full public catalog for scoped-session model autocomplete", async () => {
		const harness = await createHarness({ models: [{ id: "base", name: "Base", reasoning: true }] });
		harnesses.push(harness);
		const base = harness.getModel("base")!;
		const scoped = { ...base, provider: "prime-inference", id: "openai/gpt-5.5" } as AgentConnectionModel;
		const publicModel = { ...base, provider: "openai", id: "gpt-5.4" } as AgentConnectionModel;
		const fakeThis = Object.create(InteractiveMode.prototype) as InteractiveAutocompleteHarness;
		fakeThis.connectionState = { scopedModels: [{ model: scoped }] };
		fakeThis.connectionModelCatalog = [scoped, publicModel];
		fakeThis.connectionCommands = [];
		fakeThis.skillCommands = new Map();
		fakeThis.uiServices = { settingsManager: { getEnableSkillCommands: () => false } };
		fakeThis.bindLocalSessionExtensions = false;
		fakeThis.fdPath = undefined;
		fakeThis.currentModelSupportsFastMode = () => false;
		fakeThis.getAvailableThinkingLevels = () => [];
		fakeThis.getCurrentCwd = () => "/tmp";

		const provider = fakeThis.createBaseAutocompleteProvider();
		const suggestions = await provider.getSuggestions(["/model gpt-5.4"], 0, 14, {
			signal: new AbortController().signal,
		});

		expect(suggestions?.items).toContainEqual({
			value: "openai/gpt-5.4",
			label: "gpt-5.4",
			description: "openai",
		});
	});

	test("uses the full public catalog for agents view model autocomplete", async () => {
		const harness = await createHarness({ models: [{ id: "base", name: "Base", reasoning: true }] });
		harnesses.push(harness);
		const publicModel = { ...harness.getModel("base")!, provider: "openai", id: "gpt-5.4" };
		const refreshModelCatalog = vi.fn(async () => ({ models: [publicModel], configuredProviders: [] }));

		const completions = await getAgentsViewModelArgumentCompletions("gpt-5.4", { refreshModelCatalog });

		expect(refreshModelCatalog).toHaveBeenCalledOnce();
		expect(completions).toContainEqual({
			value: "openai/gpt-5.4",
			label: "gpt-5.4",
			description: "openai",
		});
	});

	test("filters shared model argument completions by provider and model id", () => {
		expect(
			getModelArgumentCompletions("openai gpt-5.4", [
				{ provider: "prime-inference", id: "openai/gpt-5.5" },
				{ provider: "openai", id: "gpt-5.4" },
			]),
		).toContainEqual({ value: "openai/gpt-5.4", label: "gpt-5.4", description: "openai" });
	});
});
