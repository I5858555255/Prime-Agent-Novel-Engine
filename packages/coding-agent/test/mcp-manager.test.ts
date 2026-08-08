import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { StdioMcpClient } from "../src/core/mcp/stdio-mcp-client.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

function writeMcpServerExecutable(path: string, toolNames: string[]): void {
	writeFileSync(
		path,
		String.raw`#!/usr/bin/env node
const toolNames = ${JSON.stringify(toolNames)};
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
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "default", version: "1" } });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: toolNames.map((name) => ({ name, inputSchema: { type: "object" } })) });
    } else if (message.method === "tools/call") {
      reply(message.id, { content: [] });
    }
  }
});
`,
	);
	chmodSync(path, 0o755);
}

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
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
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "default", version: "1" } });
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
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1" } });
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
		expect(readFileSync(marker, "utf8")).toContain("start:1\nstart:1");
		await manager.dispose();
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
