import { describe, expect, it } from "vitest";
import { defaultPasteImageKeys, KEYBINDINGS } from "../src/core/keybindings.js";

describe("app.clipboard.pasteImage default key", () => {
	it("uses Command-V (super+v) on macOS", () => {
		expect(defaultPasteImageKeys("darwin")).toBe("super+v");
	});

	it("uses Control-V on Linux", () => {
		expect(defaultPasteImageKeys("linux")).toBe("ctrl+v");
	});

	it("uses Alt-V on Windows so it never collides with the terminal paste", () => {
		expect(defaultPasteImageKeys("win32")).toBe("alt+v");
	});

	it("resolves the live default from the host platform", () => {
		expect(KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys).toBe(defaultPasteImageKeys());
	});
});
