import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { HarnessEntrySummary } from "../src/core/refinement/index.js";
import { HarnessSelectorComponent } from "../src/modes/interactive/components/harness-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const entry: HarnessEntrySummary = {
	kind: "subagent",
	id: "reviewer",
	scope: "project",
	title: "Review repository changes",
	path: "subagents/reviewer.json",
	enabled: true,
	version: 1,
};

describe("HarnessSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders entries and toggles the selected entry without closing", async () => {
		const onToggle = vi.fn(async (selected: HarnessEntrySummary, enabled: boolean) => ({
			...selected,
			enabled,
		}));
		const onCancel = vi.fn();
		const onRender = vi.fn();
		const selector = new HarnessSelectorComponent([entry], { onToggle, onCancel, onRender });

		expect(stripAnsi(selector.render(88).join("\n"))).toContain("project:subagent:reviewer");
		expect(stripAnsi(selector.render(88).join("\n"))).toContain("enabled");

		selector.getList().handleInput("\r");
		await vi.waitFor(() => expect(onToggle).toHaveBeenCalledWith(entry, false));
		await vi.waitFor(() => expect(stripAnsi(selector.render(88).join("\n"))).toContain("disabled"));
		expect(onCancel).not.toHaveBeenCalled();
		expect(onRender).toHaveBeenCalled();
	});

	it("closes on the configured cancel key", () => {
		const onCancel = vi.fn();
		const selector = new HarnessSelectorComponent([], {
			onToggle: vi.fn(),
			onCancel,
			onRender: vi.fn(),
		});

		selector.getList().handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledOnce();
	});
});
