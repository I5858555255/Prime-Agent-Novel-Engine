import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { createHtmlExportTheme } from "../src/core/export-html/theme.js";
import {
	getResolvedThemeColors,
	getThemeExportColors,
	loadThemeFromPath,
} from "../src/modes/interactive/theme/theme.js";

type ThemeFile = {
	name: string;
	vars?: Record<string, string | number>;
	colors: Record<string, string | number>;
	export?: {
		pageBg?: string | number;
		cardBg?: string | number;
		infoBg?: string | number;
	};
};

describe("getThemeExportColors", () => {
	let tempRoot: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-theme-export-"));
		agentDir = join(tempRoot, "agent");
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(join(agentDir, "themes"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	});

	it("resolves export variable references using the same syntax as colors", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;

		const customTheme: ThemeFile = {
			...darkTheme,
			name: "custom-export-vars",
			vars: {
				...(darkTheme.vars ?? {}),
				pageBgVar: "#112233",
				pageBgAlias: "pageBgVar",
				infoBgVar: "#445566",
				cardBgVar: "#223344",
			},
			export: {
				pageBg: "pageBgAlias",
				cardBg: "cardBgVar",
				infoBg: "infoBgVar",
			},
		};

		writeFileSync(join(agentDir, "themes", "custom-export-vars.json"), JSON.stringify(customTheme, null, 2));

		const expected = {
			pageBg: "#112233",
			cardBg: "#223344",
			infoBg: "#445566",
		};
		expect(getThemeExportColors("custom-export-vars")).toEqual(expected);
		expect(createHtmlExportTheme({ themeName: "custom-export-vars" }).exportColors).toEqual(expected);
	});

	it("resolves recursive vars and converts 256-color export values to hex", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;

		const customTheme: ThemeFile = {
			...darkTheme,
			name: "custom-export-recursive",
			vars: {
				...(darkTheme.vars ?? {}),
				deepPageBg: "#abcdef",
				pageBgAlias: "deepPageBg",
				cardBgAnsi: 24,
			},
			export: {
				pageBg: "pageBgAlias",
				cardBg: "cardBgAnsi",
				infoBg: "",
			},
		};

		writeFileSync(join(agentDir, "themes", "custom-export-recursive.json"), JSON.stringify(customTheme, null, 2));

		const expected = {
			pageBg: "#abcdef",
			cardBg: "#005f87",
			infoBg: undefined,
		};
		expect(getThemeExportColors("custom-export-recursive")).toEqual(expected);
		expect(createHtmlExportTheme({ themeName: "custom-export-recursive" }).exportColors).toEqual(expected);
	});

	it("keeps headless parsing and empty-token rendering aligned with interactive themes", () => {
		const darkTheme = JSON.parse(
			readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf-8"),
		) as ThemeFile;
		const themeName = "custom-parser-parity";
		const themePath = join(agentDir, "themes", `${themeName}.json`);
		const customTheme: ThemeFile = {
			...darkTheme,
			name: themeName,
			vars: {
				...(darkTheme.vars ?? {}),
				accentValue: "#123456",
				accentAlias: "accentValue",
				ansiOutput: 24,
			},
			colors: {
				...darkTheme.colors,
				accent: "accentAlias",
				text: "",
				userMessageBg: "",
				toolOutput: "ansiOutput",
			},
			export: {
				pageBg: "accentAlias",
				cardBg: 24,
				infoBg: "",
			},
		};
		writeFileSync(themePath, JSON.stringify(customTheme, null, 2));

		const headless = createHtmlExportTheme({ themeName });
		const interactive = loadThemeFromPath(themePath, "truecolor");

		expect(headless.colors).toEqual(getResolvedThemeColors(themeName));
		expect(headless.exportColors).toEqual(getThemeExportColors(themeName));
		expect(headless.exportColors.infoBg).toBeUndefined();
		expect(headless.toolTheme.fg("text", "sample")).toBe("\x1b[39msample\x1b[39m");
		expect(headless.toolTheme.fg("text", "sample")).toBe(interactive.fg("text", "sample"));
		expect(headless.toolTheme.bg("userMessageBg", "sample")).toBe("\x1b[49msample\x1b[49m");
		expect(headless.toolTheme.bg("userMessageBg", "sample")).toBe(interactive.bg("userMessageBg", "sample"));
		expect(headless.toolTheme.fg("toolOutput", "sample")).toBe(interactive.fg("toolOutput", "sample"));
	});
});
