import type { Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

type SelectorInternals = {
	filteredModels: Array<{ provider: string; id: string }>;
};

describe("issue #653 search must rank configured providers first", () => {
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

	it("ranks a configured provider's model above a closer match from an unconfigured provider", async () => {
		const harness = await createHarness({
			models: [{ id: "kimi-k2-thinking", name: "Kimi K2 Thinking", reasoning: true }],
		});
		harnesses.push(harness);
		const configured = harness.getModel("kimi-k2-thinking")!;
		// "k2" scores strictly better for kimi/k2 than for faux/kimi-k2-thinking,
		// so score-first ordering surfaces the provider the user cannot run.
		const unconfigured: Model<typeof configured.api> = {
			...configured,
			id: "k2",
			name: "K2",
			provider: "kimi",
		};

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"k2",
			{
				availableModels: [unconfigured, configured],
				configuredProviders: new Set([configured.provider]),
			},
		);

		const internals = selector as unknown as SelectorInternals;
		const order = internals.filteredModels.map((item) => `${item.provider}/${item.id}`);
		expect(order[0]).toBe(`${configured.provider}/${configured.id}`);
		expect(order).toContain("kimi/k2");
	});
});
