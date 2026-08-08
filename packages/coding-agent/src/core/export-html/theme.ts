import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCustomThemesDir, getThemesDir } from "../../config.js";
import type { SourceInfo } from "../source-info.js";
import type { ThemeBg, ThemeColor, ToolRenderTheme } from "../theme-types.js";

type ColorValue = string | number;

interface ThemeDocument {
	name: string;
	vars?: Record<string, ColorValue>;
	colors: Record<string, ColorValue>;
	export?: {
		pageBg?: ColorValue;
		cardBg?: ColorValue;
		infoBg?: ColorValue;
	};
}

export interface HtmlExportTheme {
	name: string;
	toolTheme: ToolRenderTheme;
	colors: Record<string, string>;
	exportColors: {
		pageBg?: string;
		cardBg?: string;
		infoBg?: string;
	};
}

export interface HtmlExportThemeOptions {
	themeName?: string;
	resources?: ReadonlyArray<{ name?: string; sourcePath?: string }>;
}

const BUILTIN_THEME_NAMES = new Set(["prime", "dark", "light"]);
const BACKGROUND_COLOR_NAMES = new Set<ThemeBg>([
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
	"toolDiffAddedBg",
	"toolDiffRemovedBg",
	"toolPanelBg",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorValue(value: unknown): value is ColorValue {
	return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function readThemeDocument(themePath: string): ThemeDocument {
	const parsed: unknown = JSON.parse(readFileSync(themePath, "utf-8"));
	if (!isRecord(parsed) || typeof parsed.name !== "string" || !isRecord(parsed.colors)) {
		throw new Error(`Invalid theme "${themePath}": expected a name and colors object`);
	}
	const colors: Record<string, ColorValue> = {};
	for (const [name, value] of Object.entries(parsed.colors)) {
		if (!isColorValue(value)) {
			throw new Error(`Invalid theme color "${name}" in ${themePath}`);
		}
		colors[name] = value;
	}
	const vars: Record<string, ColorValue> = {};
	if (parsed.vars !== undefined) {
		if (!isRecord(parsed.vars)) {
			throw new Error(`Invalid theme vars in ${themePath}`);
		}
		for (const [name, value] of Object.entries(parsed.vars)) {
			if (!isColorValue(value)) {
				throw new Error(`Invalid theme variable "${name}" in ${themePath}`);
			}
			vars[name] = value;
		}
	}
	let exportColors: ThemeDocument["export"];
	if (parsed.export !== undefined) {
		if (!isRecord(parsed.export)) {
			throw new Error(`Invalid theme export colors in ${themePath}`);
		}
		exportColors = {};
		for (const name of ["pageBg", "cardBg", "infoBg"] as const) {
			const value = parsed.export[name];
			if (value !== undefined && !isColorValue(value)) {
				throw new Error(`Invalid theme export color "${name}" in ${themePath}`);
			}
			exportColors[name] = value;
		}
	}
	return { name: parsed.name, vars, colors, export: exportColors };
}

function resolveThemePath(name: string, resources: HtmlExportThemeOptions["resources"]): string {
	const resource = resources?.find((candidate) => candidate.name === name);
	if (resource) {
		if (!resource.sourcePath) {
			throw new Error(`Theme "${name}" has no source path for HTML export`);
		}
		return resource.sourcePath;
	}
	if (BUILTIN_THEME_NAMES.has(name)) {
		return join(getThemesDir(), `${name}.json`);
	}
	const customPath = join(getCustomThemesDir(), `${name}.json`);
	if (existsSync(customPath)) {
		return customPath;
	}
	throw new Error(`Theme not found: ${name}`);
}

function resolveColor(value: ColorValue, vars: Record<string, ColorValue>, visited = new Set<string>()): ColorValue {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular theme variable reference: ${value}`);
	}
	const next = vars[value];
	if (next === undefined) {
		throw new Error(`Theme variable not found: ${value}`);
	}
	visited.add(value);
	return resolveColor(next, vars, visited);
}

function ansi256ToHex(index: number): string {
	if (index < 0 || index > 255) {
		throw new Error(`Invalid ANSI color index: ${index}`);
	}
	const basic = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < basic.length) return basic[index];
	if (index >= 232) {
		const value = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
		return `#${value}${value}${value}`;
	}
	const cube = [0, 95, 135, 175, 215, 255];
	const offset = index - 16;
	const red = cube[Math.floor(offset / 36)];
	const green = cube[Math.floor((offset % 36) / 6)];
	const blue = cube[offset % 6];
	return `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
}

function toCssColor(value: ColorValue, defaultText: string): string {
	if (typeof value === "number") return ansi256ToHex(value);
	return value === "" ? defaultText : value;
}

function toAnsi(value: ColorValue, background: boolean): string {
	if (typeof value === "number") {
		return `\x1b[${background ? 48 : 38};5;${value}m`;
	}
	if (value === "") return "";
	const match = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
	if (!match) {
		throw new Error(`Invalid theme color: ${value}`);
	}
	const channels = match.slice(1).map((channel) => Number.parseInt(channel, 16));
	return `\x1b[${background ? 48 : 38};2;${channels.join(";")}m`;
}

class HeadlessToolTheme implements ToolRenderTheme {
	readonly colorMode = "truecolor" as const;
	readonly name: string;
	readonly sourcePath: string;
	sourceInfo?: SourceInfo;
	private readonly foregrounds: Map<ThemeColor, string>;
	private readonly backgrounds: Map<ThemeBg, string>;

	constructor(name: string, sourcePath: string, colors: Record<string, ColorValue>) {
		this.name = name;
		this.sourcePath = sourcePath;
		this.foregrounds = new Map();
		this.backgrounds = new Map();
		for (const [colorName, value] of Object.entries(colors)) {
			if (BACKGROUND_COLOR_NAMES.has(colorName as ThemeBg)) {
				this.backgrounds.set(colorName as ThemeBg, toAnsi(value, true));
			} else {
				this.foregrounds.set(colorName as ThemeColor, toAnsi(value, false));
			}
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.foregrounds.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`;
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.backgrounds.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`;
	}

	getEditorBackgroundColor(): (text: string) => string {
		return (text) => this.bg("userMessageBg", text);
	}

	getUserMessageBackgroundColor(): (text: string) => string {
		return (text) => this.bg("userMessageBg", text);
	}

	getPopupBackgroundColor(): (text: string) => string {
		return (text) => this.bg("toolPanelBg", text);
	}

	getSelectionBackgroundColor(): (text: string) => string {
		return (text) => this.bg("selectedBg", text);
	}

	getAdaptiveAccentColor(): (text: string) => string {
		return (text) => this.bold(this.fg("accent", text));
	}

	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	}

	italic(text: string): string {
		return `\x1b[3m${text}\x1b[23m`;
	}

	underline(text: string): string {
		return `\x1b[4m${text}\x1b[24m`;
	}

	inverse(text: string): string {
		return `\x1b[7m${text}\x1b[27m`;
	}

	strikethrough(text: string): string {
		return `\x1b[9m${text}\x1b[29m`;
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.foregrounds.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.backgrounds.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): "truecolor" {
		return this.colorMode;
	}

	getThinkingBorderColor(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") {
		const color =
			level === "max" ? "thinkingXhigh" : (`thinking${level[0].toUpperCase()}${level.slice(1)}` as ThemeColor);
		return (text: string) => this.fg(color, text);
	}

	getBashModeBorderColor(): (text: string) => string {
		return (text) => this.fg("bashMode", text);
	}
}

export function createHtmlExportTheme(options: HtmlExportThemeOptions = {}): HtmlExportTheme {
	const name = options.themeName ?? "prime";
	const sourcePath = resolveThemePath(name, options.resources);
	const document = readThemeDocument(sourcePath);
	const vars = document.vars ?? {};
	const resolvedColors = Object.fromEntries(
		Object.entries(document.colors).map(([colorName, value]) => [colorName, resolveColor(value, vars)]),
	);
	const defaultText = name === "light" ? "#000000" : "#e5e5e7";
	const cssColors = Object.fromEntries(
		Object.entries(resolvedColors).map(([colorName, value]) => [colorName, toCssColor(value, defaultText)]),
	);
	const resolveExportColor = (value: ColorValue | undefined): string | undefined =>
		value === undefined ? undefined : toCssColor(resolveColor(value, vars), defaultText);

	return {
		name,
		toolTheme: new HeadlessToolTheme(name, sourcePath, resolvedColors),
		colors: cssColors,
		exportColors: {
			pageBg: resolveExportColor(document.export?.pageBg),
			cardBg: resolveExportColor(document.export?.cardBg),
			infoBg: resolveExportColor(document.export?.infoBg),
		},
	};
}
