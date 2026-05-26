import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { MenuPanel, MenuRow, MenuSearchInput } from "../src/modes/interactive/components/menu-panel.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class StaticComponent implements Component {
	invalidate(): void {
		// Static test component has no cached state.
	}

	render(_width: number): string[] {
		return ["first", "second"];
	}
}

describe("MenuPanel", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a surface-style menu panel with padded rows", () => {
		const panel = new MenuPanel({ title: "Menu", subtitle: "Pick one." });
		panel.addChild(new StaticComponent());

		const lines = panel.render(24);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("Menu");
		expect(output).toContain("Pick one.");
		expect(output).toContain("first");
		expect(output).toContain("second");
		expect(output).not.toContain("╭");
		expect(output).not.toContain("│");
		expect(output).not.toContain("╰");
		expect(stripAnsi(lines[0] ?? "").trim()).toBe("");
		expect(stripAnsi(lines.at(-1) ?? "").trim()).toBe("");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(24);
		}
	});

	it("renders search fields without the shell prompt", () => {
		const field = new MenuSearchInput("Search models");
		const output = stripAnsi(field.render(24).join("\n"));

		expect(output).toContain("Search models");
		expect(output).not.toContain("> ");
		expect(visibleWidth(output)).toBe(24);
	});

	it("renders selected rows as full-width surfaces without a cursor glyph", () => {
		const row = new MenuRow({
			primary: "openai/gpt-5",
			secondary: "openai",
			meta: "current",
			selected: true,
		});
		const lines = row.render(40);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("openai/gpt-5");
		expect(output).toContain("openai");
		expect(output).toContain("current");
		expect(output).not.toContain("›");
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
	});
});
