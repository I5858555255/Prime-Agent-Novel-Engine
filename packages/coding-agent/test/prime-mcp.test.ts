import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { configCandidatePaths, loadMcpConfig, parseToolRef } from "../extensions/prime-mcp/config.js";
import { adaptClient } from "../extensions/prime-mcp/connector.js";
import { type McpClientLike, type McpConnector, McpManager } from "../extensions/prime-mcp/manager.js";
import { createMcpProxyTool, type McpProxyInput } from "../extensions/prime-mcp/proxy-tool.js";

async function callProxy(manager: McpManager, params: McpProxyInput): Promise<string> {
	const tool = createMcpProxyTool(manager);
	const result = await tool.execute("call-id", params, undefined, undefined, {} as never);
	const block = result.content[0];
	return block && block.type === "text" ? block.text : "";
}

/** A real in-memory MCP server exposing an `echo` tool, wired through the SDK client + adapter. */
async function inMemoryEchoClient(): Promise<McpClientLike> {
	const server = new McpServer({ name: "echo-server", version: "1.0.0" });
	server.registerTool(
		"echo",
		{ description: "Echo the provided text back", inputSchema: { text: z.string() } },
		async ({ text }) => ({ content: [{ type: "text", text }] }),
	);
	server.registerTool("boom", { description: "Always fails", inputSchema: {} }, async () => ({
		content: [{ type: "text", text: "tool blew up" }],
		isError: true,
	}));
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(clientTransport);
	return adaptClient(client);
}

function managerWith(connector: McpConnector, idleTimeoutMs = 0): McpManager {
	return new McpManager(
		{ mcpServers: { demo: { type: "stdio", command: "noop" } }, directTools: [], idleTimeoutMs },
		{ connector },
	);
}

describe("prime-mcp config", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "prime-mcp-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("parseToolRef splits server/tool and rejects malformed refs", () => {
		expect(parseToolRef("server/tool")).toEqual({ server: "server", tool: "tool" });
		expect(parseToolRef("server/nested/tool")).toEqual({ server: "server", tool: "nested/tool" });
		expect(parseToolRef("notaref")).toBeUndefined();
		expect(parseToolRef("/leading")).toBeUndefined();
		expect(parseToolRef("trailing/")).toBeUndefined();
	});

	test("candidate paths are project-first, then global", () => {
		const paths = configCandidatePaths("/proj", "/home/user");
		expect(paths).toEqual([
			join("/proj", ".mcp.json"),
			join("/proj", ".prime", "agent", "mcp.json"),
			join("/home/user", ".prime", "agent", "mcp.json"),
		]);
	});

	test("merges global and project config with project overriding by name", async () => {
		const home = join(root, "home");
		const cwd = join(root, "proj");
		await mkdir(join(home, ".prime", "agent"), { recursive: true });
		await mkdir(join(cwd, ".prime", "agent"), { recursive: true });

		await writeFile(
			join(home, ".prime", "agent", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					globalOnly: { command: "global-cmd" },
					shared: { url: "https://global.example/mcp" },
				},
				directTools: ["globalOnly/a"],
				idleTimeoutMs: 1000,
			}),
		);
		await writeFile(
			join(cwd, ".prime", "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { projectPrime: { command: "prime-cmd" } } }),
		);
		await writeFile(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: { shared: { url: "https://project.example/mcp" } },
				directTools: ["shared/x"],
			}),
		);

		const { config, sources } = await loadMcpConfig(cwd, home);

		expect(Object.keys(config.mcpServers).sort()).toEqual(["globalOnly", "projectPrime", "shared"]);
		expect(config.mcpServers.shared).toEqual({
			type: "http",
			url: "https://project.example/mcp",
			headers: undefined,
		});
		expect(config.mcpServers.globalOnly).toEqual({
			type: "stdio",
			command: "global-cmd",
			args: undefined,
			env: undefined,
			cwd: undefined,
		});
		expect(config.directTools.sort()).toEqual(["globalOnly/a", "shared/x"]);
		expect(config.idleTimeoutMs).toBe(1000);
		// Highest precedence first.
		expect(sources[0]).toBe(join(cwd, ".mcp.json"));
	});

	test("returns empty config when no files exist", async () => {
		const { config, sources } = await loadMcpConfig(join(root, "nope"), join(root, "nohome"));
		expect(config).toEqual({ mcpServers: {}, directTools: [] });
		expect(sources).toEqual([]);
	});

	test("throws on malformed JSON", async () => {
		await writeFile(join(root, ".mcp.json"), "{ not json");
		await expect(loadMcpConfig(root, join(root, "nohome"))).rejects.toThrow(/Invalid JSON/);
	});

	test("throws when a server defines neither command nor url", async () => {
		await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { bad: { foo: 1 } } }));
		await expect(loadMcpConfig(root, join(root, "nohome"))).rejects.toThrow(/either "command".*or "url"/);
	});
});

describe("prime-mcp proxy tool", () => {
	test("lists servers, lists tools, describes and calls through the proxy", async () => {
		const manager = managerWith(async () => inMemoryEchoClient());

		const servers = await callProxy(manager, { action: "list_servers" });
		expect(servers).toContain("demo");

		const tools = await callProxy(manager, { action: "list_tools", server: "demo" });
		expect(tools).toContain("echo");

		const described = await callProxy(manager, { action: "describe", server: "demo", tool: "echo" });
		expect(described).toContain("echo");
		expect(described).toContain("text");

		const called = await callProxy(manager, {
			action: "call",
			server: "demo",
			tool: "echo",
			arguments: { text: "hello mcp" },
		});
		expect(called).toBe("hello mcp");

		await manager.disconnectAll();
	});

	test("throws when an MCP tool returns isError", async () => {
		const manager = managerWith(async () => inMemoryEchoClient());
		await expect(callProxy(manager, { action: "call", server: "demo", tool: "boom", arguments: {} })).rejects.toThrow(
			/tool blew up/,
		);
		await manager.disconnectAll();
	});

	test("reports when no servers are configured", async () => {
		const manager = new McpManager(
			{ mcpServers: {}, directTools: [] },
			{ connector: async () => inMemoryEchoClient() },
		);
		const out = await callProxy(manager, { action: "list_servers" });
		expect(out).toContain("No MCP servers are configured");
	});
});

describe("prime-mcp manager lifecycle", () => {
	test("reconnects once and retries when a call fails on a dead transport", async () => {
		let connectCount = 0;
		let failNextCall = true;
		const connector: McpConnector = async () => {
			connectCount++;
			return {
				listTools: async () => [{ name: "echo", inputSchema: { type: "object" } }],
				callTool: async () => {
					if (failNextCall) {
						failNextCall = false;
						throw new Error("transport closed");
					}
					return { content: [{ type: "text", text: "ok" }], isError: false };
				},
				close: async () => {},
			};
		};

		const manager = managerWith(connector);
		const result = await manager.callTool("demo", "echo", {});

		expect(result.isError).toBe(false);
		expect(connectCount).toBe(2);
	});

	test("does not retry when a call fails with a non-transport error", async () => {
		let connectCount = 0;
		const connector: McpConnector = async () => {
			connectCount++;
			return {
				listTools: async () => [],
				callTool: async () => {
					throw new Error("invalid arguments");
				},
				close: async () => {},
			};
		};

		const manager = managerWith(connector);
		await expect(manager.callTool("demo", "echo", {})).rejects.toThrow(/invalid arguments/);
		expect(connectCount).toBe(1);
	});

	test("disconnects an idle server after the idle timeout", async () => {
		vi.useFakeTimers();
		try {
			let closeCount = 0;
			const connector: McpConnector = async () => ({
				listTools: async () => [],
				callTool: async () => ({ content: [], isError: false }),
				close: async () => {
					closeCount++;
				},
			});

			const manager = managerWith(connector, 1000);
			await manager.listTools("demo");
			expect(manager.getStatus("demo")?.state).toBe("connected");

			await vi.advanceTimersByTimeAsync(1000);

			expect(closeCount).toBe(1);
			expect(manager.getStatus("demo")?.state).toBe("disconnected");
		} finally {
			vi.useRealTimers();
		}
	});
});
