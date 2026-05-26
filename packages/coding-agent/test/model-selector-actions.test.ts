import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ModelSelectorComponent provider actions", () => {
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

	it("shows provider setup actions after models and emits the selected action", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
		});
		harnesses.push(harness);

		let selectedAction: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("faux-1"),
			harness.settingsManager,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				actions: [
					{ id: "subscription", label: "Use a subscription", description: "sign in with another provider" },
				],
				onAction: (actionId) => {
					selectedAction = actionId;
				},
				subtitle: "Choose a Prime model, or add another provider.",
			},
		);

		await waitForAsyncRender();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Choose a Prime model, or add another provider.");
		expect(output).toContain("Use a subscription");
		expect(output).toContain("sign in with another provider");

		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(selectedAction).toBe("subscription");
	});
});
