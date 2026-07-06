import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.js";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { allToolNames, createAllToolDefinitions } from "../../../src/core/tools/index.js";

describe("regression #4428: remove legacy pi-mono built-in tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-remove-legacy-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers only ipython as a built-in tool", () => {
		expect([...allToolNames]).toEqual(["ipython"]);
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual(["ipython"]);
	});

	it("keeps legacy names available for extension and custom tool allowlists", () => {
		const result = parseArgs(["--tools", "bash,edit,ipython"]);

		expect(result.tools).toEqual(["bash", "edit", "ipython"]);
		expect(result.diagnostics).toEqual([]);
	});

	it("falls back to ipython when only removed built-in tool names are requested", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["bash", "edit"],
		});
		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["ipython"]);
		expect(session.getActiveToolNames()).toEqual(["ipython"]);
		session.dispose();
	});

	it("allowlists an extension tool that reuses a legacy built-in name", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "bash",
							label: "Custom Bash",
							description: "Tool registered from session_start",
							promptSnippet: "Run custom shell behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["bash"],
		});
		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["bash"]);
		expect(session.getActiveToolNames()).toEqual(["bash"]);
		session.dispose();
	});
});
