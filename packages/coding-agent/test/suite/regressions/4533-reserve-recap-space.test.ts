import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";

type RecapRenderMode = {
	recapContainer: Container;
	childAgentPanelMode?: "detail";
	sessionRecap?: string;
	ui: { requestRender: () => void };
};

type RenderRecapHost = {
	renderRecap(this: RecapRenderMode): void;
};

const renderRecap = (InteractiveMode.prototype as unknown as RenderRecapHost).renderRecap;

function createMode(sessionRecap?: string): RecapRenderMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		recapContainer: new Container(),
		sessionRecap,
		ui: { requestRender: vi.fn() },
	}) as RecapRenderMode;
}

function render(mode: RecapRenderMode, width = 80): string[] {
	renderRecap.call(mode);
	return mode.recapContainer.render(width);
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("ENG-4533 recap layout", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps the recap area height stable while a fresh recap is pending", () => {
		const mode = createMode("Reviewing the current implementation");
		const previous = render(mode);

		mode.sessionRecap = undefined;
		const pending = render(mode);

		mode.sessionRecap = "Preparing the fix plan";
		const updated = render(mode);

		expect(previous).toHaveLength(2);
		expect(pending).toHaveLength(2);
		expect(updated).toHaveLength(2);
		expect(pending.every((line) => line.trim() === "")).toBe(true);
		expect(stripAnsi(updated[0] ?? "")).toContain("Recap: Preparing the fix plan");
	});

	it("keeps long recaps to one row on narrow terminals", () => {
		const mode = createMode("Reviewing the implementation and preparing a clean regression test");
		const lines = render(mode, 24);

		expect(lines).toHaveLength(2);
		expect(visibleWidth(lines[0] ?? "")).toBe(24);
		expect(stripAnsi(lines[0] ?? "")).toContain("Recap:");
	});

	it("suppresses the parent recap area in child-agent detail", () => {
		const mode = createMode("Reviewing the parent session");
		mode.childAgentPanelMode = "detail";

		expect(render(mode)).toEqual([]);
	});
});
