import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { clearDefaultTerminalColors, setDefaultTerminalColors, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHtmlExportTheme } from "../../../src/core/export-html/theme.js";
import { createToolHtmlRenderer } from "../../../src/core/export-html/tool-renderer.js";
import { defineTool, type ExtensionFactory } from "../../../src/core/extensions/types.js";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.js";
import { createHarness, type Harness } from "../harness.js";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

interface ExportedSessionData {
	entries: unknown[];
	renderedTools?: Record<
		string,
		{
			callHtml?: string;
			resultHtmlCollapsed?: string;
			resultHtmlExpanded?: string;
		}
	>;
}

function decodeSessionData(html: string): ExportedSessionData {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	if (!match) throw new Error("Expected embedded session data");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as ExportedSessionData;
}

function themedTool(options: { failRendering?: boolean } = {}): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "headless_theme_tool",
			label: "Headless theme tool",
			description: "Exercises custom HTML export rendering",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: `result:${params.value}` }],
				details: { value: params.value },
			}),
			renderCall: (args, theme) => {
				if (options.failRendering) throw new Error("custom call renderer failed");
				return new Text(theme.fg("accent", `headless-call:${args.value}`), 0, 0);
			},
			renderResult: (result, _options, theme) => {
				if (options.failRendering) throw new Error("custom result renderer failed");
				const text = result.content.find((part) => part.type === "text")?.text ?? "missing";
				return new Text(theme.fg("success", `headless-result:${text}`), 0, 0);
			},
		});
	};
}

describe("regression #936: headless HTML export theme composition", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		clearDefaultTerminalColors();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		delete (globalThis as Record<symbol, unknown>)[THEME_KEY];
	});

	async function runToolAndExport(extensionFactory: ExtensionFactory): Promise<ExportedSessionData> {
		delete (globalThis as Record<symbol, unknown>)[THEME_KEY];
		const harness = await createHarness({
			persistSession: true,
			settings: { theme: "prime" },
			extensionFactories: [extensionFactory],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("headless_theme_tool", { value: "example" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("render the custom tool");

		expect((globalThis as Record<symbol, unknown>)[THEME_KEY]).toBeUndefined();
		const outputPath = join(harness.tempDir, "session.html");
		await harness.session.exportToHtml(outputPath);
		expect((globalThis as Record<symbol, unknown>)[THEME_KEY]).toBeUndefined();
		return decodeSessionData(readFileSync(outputPath, "utf-8"));
	}

	it("renders custom tool output without initializing the interactive theme", async () => {
		const sessionData = await runToolAndExport(themedTool());
		const rendered = Object.values(sessionData.renderedTools ?? {})[0];

		expect(rendered?.callHtml).toContain("headless-call:example");
		expect(rendered?.resultHtmlExpanded).toContain("headless-result:result:example");
	});

	it("reports renderer failures and intentionally keeps structured fallback data", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sessionData = await runToolAndExport(themedTool({ failRendering: true }));

		expect(warn).toHaveBeenCalledWith(expect.stringContaining("custom call renderer failed"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("custom result renderer failed"));
		expect(sessionData.renderedTools).toBeUndefined();
		expect(sessionData.entries.length).toBeGreaterThan(0);
	});

	it.each([
		{ background: { r: 245, g: 245, b: 245 }, expectedTheme: "light" },
		{ background: { r: 10, g: 10, b: 10 }, expectedTheme: "prime" },
	])("resolves an unset theme for the current terminal background", ({ background, expectedTheme }) => {
		delete (globalThis as Record<symbol, unknown>)[THEME_KEY];
		setDefaultTerminalColors({ foreground: { r: 128, g: 128, b: 128 }, background });

		const exportTheme = createHtmlExportTheme();

		expect(exportTheme.name).toBe(expectedTheme);
		expect((globalThis as Record<symbol, unknown>)[THEME_KEY]).toBeUndefined();
	});

	it("retains loaded theme source metadata for custom renderers", () => {
		const sourcePath = fileURLToPath(new URL("../../../src/modes/interactive/theme/prime.json", import.meta.url));
		const sourceInfo = createSyntheticSourceInfo(sourcePath, {
			source: "theme-package",
			scope: "project",
			origin: "package",
		});
		const exportTheme = createHtmlExportTheme({
			themeName: "prime",
			resources: [{ name: "prime", sourcePath, sourceInfo }],
		});
		const parameters = Type.Object({ value: Type.String() });
		const definition = defineTool({
			name: "source_info_theme_tool",
			label: "Source info theme tool",
			description: "Displays theme source metadata",
			parameters,
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			renderCall: (_args, theme) => new Text(`source:${theme.sourceInfo?.source ?? "missing"}`, 0, 0),
		});
		const renderer = createToolHtmlRenderer({
			getToolDefinition: (name) => (name === definition.name ? definition : undefined),
			theme: exportTheme.toolTheme,
			cwd: process.cwd(),
		});

		expect(exportTheme.toolTheme.sourceInfo).toEqual(sourceInfo);
		expect(renderer.renderCall("source-info-call", definition.name, { value: "example" })).toContain(
			"source:theme-package",
		);
	});
});
