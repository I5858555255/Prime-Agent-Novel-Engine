import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

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
});
