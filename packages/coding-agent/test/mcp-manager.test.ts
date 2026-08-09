import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import {
	StdioMcpClient,
	StdioMcpRequestNotSentError,
	StdioMcpTransportError,
} from "../src/core/mcp/stdio-mcp-client.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

interface TestMcpServerOptions {
	protocolVersion?: string;
	capabilities?: unknown;
	serverInfo?: unknown;
	includeCapabilities?: boolean;
	includeServerInfo?: boolean;
	callDelayMs?: number;
	callCounterFile?: string;
	pidFile?: string;
	closeStdinAfterInitialize?: boolean;
}

function writeMcpServerExecutable(path: string, toolNames: string[], options: TestMcpServerOptions = {}): void {
	const protocolVersion = JSON.stringify(options.protocolVersion ?? "2024-11-05");
	const capabilities = JSON.stringify(Object.hasOwn(options, "capabilities") ? options.capabilities : { tools: {} });
	const serverInfo = JSON.stringify(
		Object.hasOwn(options, "serverInfo") ? options.serverInfo : { name: "default", version: "1" },
	);
	const callDelayMs = options.callDelayMs ?? 0;
	const callCounterFile = JSON.stringify(options.callCounterFile ?? null);
	const pidFile = JSON.stringify(options.pidFile ?? null);
	const includeCapabilities = options.includeCapabilities !== false;
	const includeServerInfo = options.includeServerInfo !== false;
	const initializeFields = [
		`protocolVersion: ${protocolVersion}`,
		...(includeCapabilities ? [`capabilities: ${capabilities}`] : []),
		...(includeServerInfo ? [`serverInfo: ${serverInfo}`] : []),
	].join(", ");
	writeFileSync(
		path,
		String.raw`#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const toolNames = ${JSON.stringify(toolNames)};
const callDelayMs = ${callDelayMs};
const callCounterFile = ${callCounterFile};
const pidFile = ${pidFile};
let input = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
if (pidFile) writeFileSync(pidFile, String(process.pid));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const index = input.indexOf("\n");
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, { ${initializeFields} });
      ${options.closeStdinAfterInitialize ? "setTimeout(() => process.stdin.destroy(), 25);" : ""}
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })) });
    } else if (message.method === "tools/call") {
      if (callCounterFile) appendFileSync(callCounterFile, message.params.name + "\n");
      const respond = () => reply(message.id, { content: [] });
      if (callDelayMs > 0) setTimeout(respond, callDelayMs);
      else respond();
    }
  }
});
`,
	);
	chmodSync(path, 0o755);
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
	}
	throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	const managers = new Set<McpManager>();

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(async () => {
		await Promise.allSettled([...managers].map((manager) => manager.dispose()));
		managers.clear();
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disables every built-in integration when no credentials exist", () => {
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");
	});

	it("resolves bundled Python integrations as lazy stdio defaults", async () => {
		const manager = new McpManager({ authStorage });
		expect(manager.listStatus()).toEqual(
			expect.arrayContaining([
				{ server: "jcodemunch", label: "jCodeMunch", enabled: true, usesOAuth: false },
				{ server: "context-mode", label: "Context Mode", enabled: true, usesOAuth: false },
			]),
		);
		const handlers = manager.hostHandlers();
		// Resolving the default config must not construct or launch either sidecar.
		expect(await handlers["mcp.config"]({ server: "jcodemunch" })).toEqual({
			type: "stdio",
			bridge: "host",
		});
		expect(await handlers["mcp.config"]({ server: "context-mode" })).toEqual({
			type: "stdio",
			bridge: "host",
		});
		manager.disposeSync();
	});

	it("launches the default command only when its first tool is requested", async () => {
		const marker = join(tempDir, "default-stdio-marker");
		const executable = join(tempDir, "jcodemunch-mcp");
		writeFileSync(
			executable,
			String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const marker = process.env.MARKER;
let input = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const index = input.indexOf("\n");
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      appendFileSync(marker, "started\n");
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "default", version: "1" } });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [{ name: "search_symbols", inputSchema: { type: "object" } }] });
    }
  }
});
`,
		);
		chmodSync(executable, 0o755);
		const previousPath = process.env.PATH;
		const previousMarker = process.env.MARKER;
		process.env.PATH = `${tempDir}:${previousPath ?? ""}`;
		process.env.MARKER = marker;
		const manager = new McpManager({ authStorage });
		try {
			expect(() => readFileSync(marker, "utf8")).toThrow();
			expect(await manager.hostHandlers()["mcp.config"]({ server: "jcodemunch" })).toEqual({
				type: "stdio",
				bridge: "host",
			});
			expect(() => readFileSync(marker, "utf8")).toThrow();
			expect((await manager.hostHandlers()["mcp.list_tools"]({ server: "jcodemunch" })).tools).toEqual([
				expect.objectContaining({ name: "search_symbols" }),
			]);
			expect(readFileSync(marker, "utf8")).toBe("started\n");
		} finally {
			await manager.dispose();
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousMarker === undefined) delete process.env.MARKER;
			else process.env.MARKER = previousMarker;
		}
	});

	it("enforces curated default tool surfaces for list and call", async () => {
		const jcodemunchTools = [
			"search_symbols",
			"get_file_outline",
			"get_symbol_source",
			"get_context_bundle",
			"get_ranked_context",
			"find_references",
			"find_importers",
			"get_blast_radius",
			"get_changed_symbols",
			"plan_turn",
			"assemble_task_context",
		];
		const contextModeTools = [
			"ctx_execute",
			"ctx_execute_file",
			"ctx_index",
			"ctx_search",
			"ctx_fetch_and_index",
			"ctx_batch_execute",
		];
		writeMcpServerExecutable(join(tempDir, "jcodemunch-mcp"), [...jcodemunchTools, "index_repo", "summarize_repo"]);
		writeMcpServerExecutable(join(tempDir, "context-mode"), [...contextModeTools, "ctx_upgrade", "ctx_purge"]);
		const previousPath = process.env.PATH;
		process.env.PATH = `${tempDir}:${previousPath ?? ""}`;
		const manager = new McpManager({ authStorage });
		try {
			const handlers = manager.hostHandlers();
			for (const [server, allowedTools, blockedTools] of [
				["jcodemunch", jcodemunchTools, ["index_repo", "summarize_repo"]],
				["context-mode", contextModeTools, ["ctx_upgrade", "ctx_purge"]],
			] as const) {
				const result = await handlers["mcp.list_tools"]({ server });
				const listedTools = (result.tools as Array<{ name: string }> | undefined)?.map((tool) => tool.name);
				expect(listedTools).toEqual(allowedTools);
				for (const tool of blockedTools) {
					await expect(handlers["mcp.call_tool"]({ server, tool })).rejects.toThrow("not allowed");
				}
			}
		} finally {
			await manager.dispose();
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("allows settings to override or disable bundled local integrations", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				jcodemunch: {
					type: "http",
					url: "https://proxy.test/jcodemunch",
					enabledTools: ["search_symbols"],
					disabledTools: ["get_blast_radius"],
				},
				"context-mode": {
					type: "stdio",
					command: process.execPath,
					enabled: false,
				},
			}),
		});
		const handlers = manager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "jcodemunch" })).toEqual({
			url: "https://proxy.test/jcodemunch",
			enabledTools: ["search_symbols"],
			disabledTools: ["get_blast_radius"],
		});
		expect(await handlers["mcp.config"]({ server: "context-mode" })).toEqual({ enabled: false });
		expect(manager.listStatus().find((status) => status.server === "context-mode")?.enabled).toBe(false);
		manager.disposeSync();
	});

	it("enables an integration once credentials are stored", () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).not.toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");

		const status = manager.listStatus().find((s) => s.server === "linear");
		expect(status?.enabled).toBe(true);
	});

	it("registers an OAuth provider per built-in integration", () => {
		new McpManager({ authStorage });
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("keeps MCP providers registered after ModelRegistry.refresh() resets the registry", () => {
		new McpManager({ authStorage });
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.refresh(); // calls resetOAuthProviders(); must re-add MCP providers
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("re-registers user-declared OAuth servers after ModelRegistry.refresh via the reset hook", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.setOnOAuthProvidersReset(() => manager.registerUserProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("exposes only mcp.refresh when no interactive login is wired", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual([
			"mcp.call_tool",
			"mcp.config",
			"mcp.health",
			"mcp.list_tools",
			"mcp.refresh",
			"mcp.restart",
		]);

		// refresh with no credentials fails (so the kernel reports a refresh error,
		// not a false success), and a missing server arg is rejected.
		await expect(handlers["mcp.refresh"]({ server: "linear" })).rejects.toThrow("Could not refresh");
		await expect(handlers["mcp.refresh"]({})).rejects.toThrow("requires a server");
	});

	it("exposes mcp.begin_login only when beginLogin is provided", async () => {
		let called = "";
		const manager = new McpManager({
			authStorage,
			beginLogin: async (server) => {
				called = server;
			},
		});
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual([
			"mcp.begin_login",
			"mcp.call_tool",
			"mcp.config",
			"mcp.health",
			"mcp.list_tools",
			"mcp.refresh",
			"mcp.restart",
		]);
		await handlers["mcp.begin_login"]({ server: "linear" });
		expect(called).toBe("linear");
	});

	it("mcp.config returns the resolved URL + headers, honoring a user override of a catalog name", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				linear: {
					type: "http",
					url: "https://proxy.test/mcp",
					oauth: true,
					headers: { "X-Extra": "1" },
					enabledTools: ["allowed"],
					disabledTools: ["blocked"],
				},
			}),
		});
		const handlers = manager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "linear" })).toEqual({
			url: "https://proxy.test/mcp",
			headers: { "X-Extra": "1" },
			enabledTools: ["allowed"],
			disabledTools: ["blocked"],
		});
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({ url: "https://mcp.notion.com/mcp" });
	});

	it("mcp.config denies an explicitly disabled user server", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				jcodemunch: { type: "http", url: "https://sidecar.test/mcp", enabled: false },
			}),
		});
		expect(await manager.hostHandlers()["mcp.config"]({ server: "jcodemunch" })).toEqual({ enabled: false });
	});

	it("does not treat an oauth override of a catalog name as authed via the official stored cred", () => {
		// Pre-existing official Linear cred from a prior login.
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "official",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp", oauth: true } }),
		});
		// Must NOT be enabled — else the official token would be sent to the override URL.
		expect(manager.listStatus().find((s) => s.server === "linear")?.enabled).toBe(false);
	});

	it("honors a bearer-token env var for user-declared servers", () => {
		process.env.MY_MCP_TOKEN = "secret";
		try {
			const manager = new McpManager({
				authStorage,
				getUserServers: () => ({
					custom: { type: "http", url: "https://example.test/mcp", bearerTokenEnvVar: "MY_MCP_TOKEN" },
				}),
			});
			const status = manager.listStatus().find((s) => s.server === "custom");
			expect(status?.enabled).toBe(true);
		} finally {
			delete process.env.MY_MCP_TOKEN;
		}
	});

	it("picks up mcpServers added after construction on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeUndefined();

		servers = { acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } };
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("drops the built-in provider when a catalog name is overridden without oauth", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp" } }),
		});
		void manager;
		// Built-in linear provider must be gone so we don't send the official token to the override URL.
		expect(getOAuthProvider("mcp:linear")).toBeUndefined();
	});

	it("unregisters a user server's OAuth provider when it's removed on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {
			acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true },
		};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(getOAuthProvider("mcp:acme")).toBeDefined();

		servers = {};
		manager.refresh();
		expect(getOAuthProvider("mcp:acme")).toBeUndefined();
	});

	it("lazily launches one durable stdio process, filters tools host-side, and restarts it", async () => {
		const marker = join(tempDir, "stdio-marker");
		const serverScript = join(tempDir, "stdio-server.mjs");
		writeFileSync(
			serverScript,
			String.raw`
import { appendFileSync } from "node:fs";
const marker = process.env.MARKER;
let input = "";
let starts = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const index = input.indexOf("\n");
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      starts += 1;
      appendFileSync(marker, "start:" + starts + "\n");
      appendFileSync(marker, "pid:" + process.pid + "\n");
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [
        { name: "allowed", description: "allowed", inputSchema: { type: "object" } },
        { name: "blocked", description: "blocked", inputSchema: { type: "object" } },
      ] });
    } else if (message.method === "tools/call") {
      reply(message.id, { structuredContent: { tool: message.params.name, cwd: process.cwd(), arguments: message.params.arguments }, content: [] });
    } else if (message.method === "ping") {
      reply(message.id, {});
    }
  }
});
`,
		);
		const manager = new McpManager({
			authStorage,
			cwd: tempDir,
			getUserServers: () => ({
				local: {
					type: "stdio",
					command: process.execPath,
					args: [serverScript],
					cwd: ".",
					env: { MARKER: marker },
					enabledTools: ["allowed"],
					disabledTools: ["blocked"],
				},
			}),
		});
		managers.add(manager);
		const handlers = manager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "local" })).toEqual({ type: "stdio", bridge: "host" });
		expect(() => readFileSync(marker, "utf8")).toThrow();

		expect((await handlers["mcp.list_tools"]({ server: "local" })).tools).toEqual([
			expect.objectContaining({ name: "allowed" }),
		]);
		expect(readFileSync(marker, "utf8")).toContain("start:1");
		const callResult = await handlers["mcp.call_tool"]({ server: "local", tool: "allowed", arguments: { value: 1 } });
		expect(callResult).toEqual({
			result: {
				structuredContent: { tool: "allowed", cwd: realpathSync(tempDir), arguments: { value: 1 } },
				content: [],
			},
		});
		await expect(handlers["mcp.call_tool"]({ server: "local", tool: "blocked" })).rejects.toThrow("not allowed");
		await handlers["mcp.health"]({ server: "local" });
		await handlers["mcp.restart"]({ server: "local" });
		expect(
			readFileSync(marker, "utf8")
				.split("\n")
				.filter((line) => line === "start:1"),
		).toHaveLength(2);
		await manager.dispose();
		const pidLine = readFileSync(marker, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("pid:"))
			.at(-1);
		expect(pidLine).toBeDefined();
		await waitForProcessExit(Number(pidLine!.slice("pid:".length)));
	});

	it("retains failed client cleanup for a later manager retry", async () => {
		const manager = new McpManager({ authStorage, cwd: tempDir });
		managers.add(manager);
		const failedClient = new StdioMcpClient({
			server: "failed",
			command: process.execPath,
			args: [],
			cwd: tempDir,
			env: process.env,
		});
		const successfulClient = new StdioMcpClient({
			server: "successful",
			command: process.execPath,
			args: [],
			cwd: tempDir,
			env: process.env,
		});
		const cleanupError = new Error("cleanup failed");
		const failedDispose = vi
			.spyOn(failedClient, "dispose")
			.mockRejectedValueOnce(cleanupError)
			.mockResolvedValue(undefined);
		const successfulDispose = vi.spyOn(successfulClient, "dispose").mockResolvedValue(undefined);
		const clients = (manager as unknown as { stdioClients: Map<string, StdioMcpClient> }).stdioClients;
		clients.set("failed", failedClient);
		clients.set("successful", successfulClient);

		try {
			await expect(manager.dispose()).rejects.toThrow("cleanup failed");
			expect(failedDispose).toHaveBeenCalledTimes(1);
			expect(successfulDispose).toHaveBeenCalledTimes(1);
			expect(clients.get("failed")).toBe(failedClient);
			expect(clients.has("successful")).toBe(false);

			await manager.dispose();
			expect(failedDispose).toHaveBeenCalledTimes(2);
			expect(clients.size).toBe(0);
		} finally {
			await manager.dispose().catch(() => undefined);
		}
	});

	it("keeps refreshed clients under exit cleanup while an old dispose is pending", async () => {
		const manager = new McpManager({ authStorage, cwd: tempDir });
		managers.add(manager);
		const oldClient = new StdioMcpClient({
			server: "old",
			command: process.execPath,
			args: [],
			cwd: tempDir,
			env: process.env,
		});
		const newClient = new StdioMcpClient({
			server: "new",
			command: process.execPath,
			args: [],
			cwd: tempDir,
			env: process.env,
		});
		let resolveOldDispose!: () => void;
		const oldDisposeCompletion = new Promise<void>((resolve) => {
			resolveOldDispose = resolve;
		});
		const oldDispose = vi.spyOn(oldClient, "dispose").mockReturnValue(oldDisposeCompletion);
		const oldDisposeSync = vi.spyOn(oldClient, "disposeSync").mockImplementation(() => undefined);
		const newDisposeSync = vi.spyOn(newClient, "disposeSync").mockImplementation(() => undefined);
		const clients = (manager as unknown as { stdioClients: Map<string, StdioMcpClient> }).stdioClients;
		clients.set("local", oldClient);

		const oldManagerDispose = manager.dispose();
		try {
			expect(oldDispose).toHaveBeenCalledTimes(1);
			manager.refresh();
			expect(oldDisposeSync).toHaveBeenCalledTimes(1);
			clients.set("local", newClient);

			resolveOldDispose();
			await oldManagerDispose;
			expect(clients.get("local")).toBe(newClient);

			const cleanup = process.listeners("exit").find((listener) => listener.toString().includes("liveMcpManagers"));
			expect(cleanup).toBeDefined();
			(cleanup as ((code: number) => void) | undefined)?.(0);
			expect(newDisposeSync).toHaveBeenCalledTimes(1);
		} finally {
			resolveOldDispose();
			await oldManagerDispose;
			await manager.dispose().catch(() => undefined);
		}
	});

	it("retries a call when the request was definitely not sent", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ local: { type: "stdio", command: process.execPath } }),
		});
		const client = new StdioMcpClient({
			server: "local",
			command: process.execPath,
			args: [],
			cwd: tempDir,
			env: process.env,
		});
		const callTool = vi
			.spyOn(client, "callTool")
			.mockRejectedValueOnce(new StdioMcpRequestNotSentError("MCP server local is not running"))
			.mockResolvedValueOnce({ ok: true });
		const restart = vi.spyOn(client, "restart").mockResolvedValue(undefined);
		(manager as unknown as { stdioClients: Map<string, StdioMcpClient> }).stdioClients.set("local", client);
		try {
			expect(await manager.hostHandlers()["mcp.call_tool"]({ server: "local", tool: "allowed" })).toEqual({
				result: { ok: true },
			});
			expect(callTool).toHaveBeenCalledTimes(2);
			expect(restart).toHaveBeenCalledTimes(1);
		} finally {
			await manager.dispose();
		}
	});

	it("does not retry a possibly-delivered timed-out tool call", async () => {
		const counterFile = join(tempDir, "tool-calls");
		const serverScript = join(tempDir, "slow-stdio-server.mjs");
		writeMcpServerExecutable(serverScript, ["allowed"], { callDelayMs: 200, callCounterFile: counterFile });
		const manager = new McpManager({
			authStorage,
			cwd: tempDir,
			getUserServers: () => ({
				local: { type: "stdio", command: process.execPath, args: [serverScript], cwd: tempDir },
			}),
		});
		const client = new StdioMcpClient({
			server: "local",
			command: process.execPath,
			args: [serverScript],
			cwd: tempDir,
			env: process.env,
			callTimeoutMs: 30,
		});
		const restart = vi.spyOn(client, "restart");
		(manager as unknown as { stdioClients: Map<string, StdioMcpClient> }).stdioClients.set("local", client);
		try {
			await expect(manager.hostHandlers()["mcp.call_tool"]({ server: "local", tool: "allowed" })).rejects.toThrow(
				"timed out during tools/call",
			);
			expect(readFileSync(counterFile, "utf8")).toBe("allowed\n");
			expect(restart).not.toHaveBeenCalled();
		} finally {
			await manager.dispose();
		}
	});

	it("waits for a timed-out tool's process to exit before dispatching the next call", async () => {
		const timelineFile = join(tempDir, "timeout-timeline");
		const counterFile = join(tempDir, "timeout-counter");
		const serverScript = join(tempDir, "timeout-serialization-server.mjs");
		writeFileSync(
			serverScript,
			String.raw`import { appendFileSync } from "node:fs";
const timeline = ${JSON.stringify(timelineFile)};
const counter = ${JSON.stringify(counterFile)};
const pid = process.pid;
const log = (event, value) => appendFileSync(timeline, event + ":" + value + ":" + Date.now() + ":" + pid + "\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
let input = "";
process.on("exit", () => log("exit", "process"));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const index = input.indexOf("\n");
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      log("ready", "process");
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "timeout", version: "1" } });
    } else if (message.method === "tools/call") {
      const name = message.params.name;
      appendFileSync(counter, name + "\n");
      log("start", name);
      const finish = () => {
        log("end", name);
        reply(message.id, { content: [] });
      };
      if (name === "first") setTimeout(finish, 250);
      else finish();
    }
  }
});
`,
		);
		const manager = new McpManager({
			authStorage,
			cwd: tempDir,
			getUserServers: () => ({
				local: {
					type: "stdio",
					command: process.execPath,
					args: [serverScript],
					cwd: tempDir,
					enabledTools: ["first", "second"],
				},
			}),
		});
		const client = new StdioMcpClient({
			server: "local",
			command: process.execPath,
			args: [serverScript],
			cwd: tempDir,
			env: process.env,
			startupTimeoutMs: 1_000,
			callTimeoutMs: 80,
		});
		(manager as unknown as { stdioClients: Map<string, StdioMcpClient> }).stdioClients.set("local", client);
		try {
			await expect(manager.hostHandlers()["mcp.call_tool"]({ server: "local", tool: "first" })).rejects.toThrow(
				"timed out during tools/call",
			);
			await expect(manager.hostHandlers()["mcp.call_tool"]({ server: "local", tool: "second" })).resolves.toEqual({
				result: { content: [] },
			});

			const events = readFileSync(timelineFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => line.split(":"));
			const firstStarts = events.filter((event) => event[0] === "start" && event[1] === "first");
			const firstEnds = events.filter((event) => event[0] === "end" && event[1] === "first");
			const secondStarts = events.filter((event) => event[0] === "start" && event[1] === "second");
			expect(firstStarts).toHaveLength(1);
			expect(firstEnds).toHaveLength(1);
			expect(secondStarts).toHaveLength(1);
			const firstPid = firstStarts[0][3];
			const firstExit = events.find((event) => event[0] === "exit" && event[3] === firstPid);
			expect(firstExit).toBeDefined();
			expect(Number(secondStarts[0][2])).toBeGreaterThanOrEqual(Number(firstExit![2]));
			expect(readFileSync(counterFile, "utf8").trim().split("\n")).toEqual(["first", "second"]);
		} finally {
			await manager.dispose();
		}
	});

	it("validates the initialize handshake and tool capability", async () => {
		const cases = [
			{
				name: "unsupported version",
				options: { protocolVersion: "2099-01-01" },
				error: "unsupported protocol version",
			},
			{ name: "missing capabilities", options: { includeCapabilities: false }, error: "invalid capabilities" },
			{ name: "missing serverInfo", options: { includeServerInfo: false }, error: "invalid serverInfo" },
			{ name: "missing tools", options: { capabilities: {} }, error: "did not negotiate tool support" },
		] as const;
		for (const testCase of cases) {
			const serverScript = join(tempDir, `${testCase.name.replaceAll(" ", "-")}.mjs`);
			writeMcpServerExecutable(serverScript, ["allowed"], testCase.options);
			const client = new StdioMcpClient({
				server: testCase.name,
				command: process.execPath,
				args: [serverScript],
				cwd: tempDir,
				env: process.env,
				startupTimeoutMs: 500,
				callTimeoutMs: 500,
			});
			try {
				await expect(client.listTools()).rejects.toThrow(testCase.error);
				if (testCase.name === "missing tools") {
					await expect(client.callTool("allowed", {})).rejects.toThrow("did not negotiate tool support");
				}
			} finally {
				await client.dispose();
			}
		}
	});

	it("handles a server closing stdin without an unhandled EPIPE", async () => {
		const serverScript = join(tempDir, "close-stdin-server.mjs");
		writeMcpServerExecutable(serverScript, ["allowed"]);
		const client = new StdioMcpClient({
			server: "close-stdin",
			command: process.execPath,
			args: [serverScript],
			cwd: tempDir,
			env: process.env,
			startupTimeoutMs: 500,
			callTimeoutMs: 100,
		});
		try {
			await client.listTools();
			const child = (client as unknown as { child?: { stdin: { destroy: () => void } } }).child;
			expect(child).toBeDefined();
			child?.stdin.destroy();
			await expect(client.callTool("allowed", {})).rejects.toBeInstanceOf(StdioMcpTransportError);
		} finally {
			await client.dispose();
		}
	});

	it("shuts down an EOF-aware sidecar without signal escalation", async () => {
		const marker = join(tempDir, "eof-marker");
		const pidFile = join(tempDir, "eof-pid");
		const serverScript = join(tempDir, "eof-server.mjs");
		writeFileSync(
			serverScript,
			String.raw`import { appendFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const pidFile = ${JSON.stringify(pidFile)};
writeFileSync(pidFile, String(process.pid));
let input = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => { appendFileSync(marker, "eof\n"); process.exit(0); });
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const index = input.indexOf("\n");
    const message = JSON.parse(input.slice(0, index));
    input = input.slice(index + 1);
    if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "eof", version: "1" } });
    else if (message.method === "tools/list") reply(message.id, { tools: [] });
  }
});
`,
		);
		chmodSync(serverScript, 0o755);
		const client = new StdioMcpClient({
			server: "eof",
			command: process.execPath,
			args: [serverScript],
			cwd: tempDir,
			env: process.env,
			startupTimeoutMs: 500,
		});
		try {
			await client.listTools();
			const pid = Number(readFileSync(pidFile, "utf8"));
			await client.dispose();
			expect(readFileSync(marker, "utf8")).toBe("eof\n");
			await waitForProcessExit(pid);
		} finally {
			await client.dispose();
		}
	});

	it("escalates EOF to SIGTERM and SIGKILL, waiting for exit", async () => {
		const marker = join(tempDir, "escalation-marker");
		const pidFile = join(tempDir, "escalation-pid");
		const serverScript = join(tempDir, "escalation-server.mjs");
		writeFileSync(
			serverScript,
			String.raw`import { appendFileSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
const pidFile = ${JSON.stringify(pidFile)};
writeFileSync(pidFile, String(process.pid));
let input = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => appendFileSync(marker, "eof\n"));
process.on("SIGTERM", () => appendFileSync(marker, "term\n"));
setInterval(() => undefined, 1000);
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const index = input.indexOf("\n");
    const message = JSON.parse(input.slice(0, index));
    input = input.slice(index + 1);
    if (message.method === "initialize") reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "escalation", version: "1" } });
    else if (message.method === "tools/list") reply(message.id, { tools: [] });
  }
});
`,
		);
		chmodSync(serverScript, 0o755);
		const client = new StdioMcpClient({
			server: "escalation",
			command: process.execPath,
			args: [serverScript],
			cwd: tempDir,
			env: process.env,
			startupTimeoutMs: 500,
		});
		try {
			await client.listTools();
			const pid = Number(readFileSync(pidFile, "utf8"));
			await client.dispose();
			expect(readFileSync(marker, "utf8")).toContain("eof\n");
			expect(readFileSync(marker, "utf8")).toContain("term\n");
			await waitForProcessExit(pid);
		} finally {
			await client.dispose();
		}
	});

	it("surfaces a transport error when SIGKILL exit remains unobserved", async () => {
		type TestChild = {
			exitCode: number | null;
			signalCode: NodeJS.Signals | null;
			stdin: { destroyed: boolean; end: () => void };
		};
		type ClientInternals = {
			child?: TestChild;
			waitForExit: (child: TestChild) => Promise<boolean>;
			killProcessTree: (child: TestChild, signal: NodeJS.Signals) => void;
			handleChildFailure: (child: TestChild, error: Error) => void;
		};
		const client = new StdioMcpClient({
			server: "unobserved-exit",
			command: process.execPath,
			args: [],
			cwd: tempDir,
			env: process.env,
		});
		const internals = client as unknown as ClientInternals;
		const child: TestChild = {
			exitCode: null,
			signalCode: null,
			stdin: { destroyed: false, end: vi.fn() },
		};
		internals.child = child;
		const waitForExit = vi.spyOn(internals, "waitForExit").mockResolvedValue(false);
		const killProcessTree = vi.spyOn(internals, "killProcessTree").mockImplementation(() => undefined);

		await expect(client.dispose()).rejects.toThrow("did not exit after SIGKILL");
		expect(waitForExit).toHaveBeenCalledTimes(3);
		expect(killProcessTree).toHaveBeenNthCalledWith(1, child, "SIGTERM");
		expect(killProcessTree).toHaveBeenNthCalledWith(2, child, "SIGKILL");
		expect(internals.child).toBe(child);

		child.exitCode = 0;
		internals.handleChildFailure(child, new Error("process exited"));
		expect(internals.child).toBeUndefined();
	});

	it("re-registers a disposed manager for process-exit cleanup after refresh", async () => {
		const pidFile = join(tempDir, "refresh-pid");
		const serverScript = join(tempDir, "refresh-server.mjs");
		writeMcpServerExecutable(serverScript, ["allowed"], { pidFile });
		const manager = new McpManager({
			authStorage,
			cwd: tempDir,
			getUserServers: () => ({
				local: { type: "stdio", command: process.execPath, args: [serverScript], cwd: tempDir },
			}),
		});
		managers.add(manager);
		await manager.hostHandlers()["mcp.list_tools"]({ server: "local" });
		await manager.dispose();
		manager.refresh();
		await manager.hostHandlers()["mcp.list_tools"]({ server: "local" });
		const pid = Number(readFileSync(pidFile, "utf8"));
		const cleanup = process.listeners("exit").find((listener) => listener.toString().includes("liveMcpManagers"));
		expect(cleanup).toBeDefined();
		(cleanup as ((code: number) => void) | undefined)?.(0);
		await waitForProcessExit(pid);
	});

	it("rejects malformed JSON-RPC responses instead of treating them as success", async () => {
		const serverScript = join(tempDir, "malformed-stdio-server.mjs");
		writeFileSync(
			serverScript,
			String.raw`
process.stdin.on("data", () => process.stdout.write(JSON.stringify({ id: 1, result: { protocolVersion: "2024-11-05" } }) + "\n"));
`,
		);
		const client = new StdioMcpClient({
			server: "malformed",
			command: process.execPath,
			args: [serverScript],
			cwd: tempDir,
			env: process.env,
		});
		try {
			await expect(client.listTools()).rejects.toThrow("invalid response");
		} finally {
			await client.dispose();
		}
	});
});
