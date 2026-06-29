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
import { renderMcpCall } from "../extensions/prime-mcp/content.js";
import { directToolName, registerDirectTools } from "../extensions/prime-mcp/direct-tools.js";
import { type McpClientLike, type McpConnector, McpManager } from "../extensions/prime-mcp/manager.js";
import { createMcpProxyTool, type McpProxyInput } from "../extensions/prime-mcp/proxy-tool.js";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.js";

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
	return adaptClient(client, "demo");
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
		const { config, sources, warnings } = await loadMcpConfig(join(root, "nope"), join(root, "nohome"));
		expect(config).toEqual({ mcpServers: {}, directTools: [] });
		expect(sources).toEqual([]);
		expect(warnings).toEqual([]);
	});

	test("warns and skips a malformed file instead of failing the whole load", async () => {
		const home = join(root, "home");
		await mkdir(join(home, ".prime", "agent"), { recursive: true });
		await writeFile(
			join(home, ".prime", "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { good: { command: "ok" } } }),
		);
		await writeFile(join(root, ".mcp.json"), "{ not json");

		const { config, warnings } = await loadMcpConfig(root, home);
		expect(Object.keys(config.mcpServers)).toEqual(["good"]);
		expect(warnings.some((w) => /Invalid JSON/.test(w))).toBe(true);
	});

	test("warns when a server defines neither command nor url", async () => {
		await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { bad: { foo: 1 } } }));
		const { warnings } = await loadMcpConfig(root, join(root, "nohome"));
		expect(warnings.some((w) => /either "command".*or "url"/.test(w))).toBe(true);
	});

	test("warns when a header value is not a string", async () => {
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { remote: { url: "https://x/mcp", headers: { Authorization: 123 } } } }),
		);
		const { warnings } = await loadMcpConfig(root, join(root, "nohome"));
		expect(warnings.some((w) => /headers\.Authorization must be a string/.test(w))).toBe(true);
	});

	test("warns when both command and url are defined", async () => {
		await writeFile(
			join(root, ".mcp.json"),
			JSON.stringify({ mcpServers: { mixed: { command: "x", url: "https://x/mcp" } } }),
		);
		const { warnings } = await loadMcpConfig(root, join(root, "nohome"));
		expect(warnings.some((w) => /defines both "command".*and "url"/.test(w))).toBe(true);
	});

	test("drops a global directTools entry when a project file redefines its server", async () => {
		const home = join(root, "home");
		await mkdir(join(home, ".prime", "agent"), { recursive: true });
		await writeFile(
			join(home, ".prime", "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { shared: { command: "trusted" } }, directTools: ["shared/echo"] }),
		);
		await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "attacker" } } }));

		const { config, warnings } = await loadMcpConfig(root, home);
		expect(config.directTools).toEqual([]);
		expect(warnings.some((w) => /Ignoring directTools entry "shared\/echo"/.test(w))).toBe(true);
	});
});

describe("prime-mcp content rendering", () => {
	test("passes image blocks through as image content and keeps text", () => {
		const rendered = renderMcpCall([
			{ type: "text", text: "here is a chart" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		expect(rendered.content).toEqual([
			{ type: "text", text: "here is a chart" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});

	test("renders resource_link blocks with their uri instead of a placeholder", () => {
		const rendered = renderMcpCall([{ type: "resource_link", name: "report", uri: "file:///report.md" }]);
		expect(rendered.text).toContain("file:///report.md");
		expect(rendered.text).toContain("report");
	});

	test("falls back to structuredContent when there is no content", () => {
		const rendered = renderMcpCall([], { answer: 42 });
		expect(rendered.text).toContain("answer");
		expect(rendered.text).toContain("42");
	});

	test("ignores nullish content blocks instead of failing the whole render", () => {
		const rendered = renderMcpCall([null, undefined, { type: "text", text: "ok" }]);
		expect(rendered.content).toEqual([{ type: "text", text: "ok" }]);
		expect(rendered.text).toBe("ok");
	});

	test("bounds the error summary text so a huge payload can't flood the transcript", () => {
		const rendered = renderMcpCall([{ type: "text", text: "x".repeat(100_000) }]);
		expect(rendered.text.length).toBeLessThan(30_000);
		expect(rendered.text).toContain("[Output truncated");
	});
});

describe("prime-mcp direct tool naming", () => {
	test("keeps short names verbatim", () => {
		expect(directToolName("demo", "echo")).toBe("mcp__demo__echo");
	});

	test("caps names that exceed the provider limit while staying unique", () => {
		const long = directToolName("server", "t".repeat(80));
		expect(long.length).toBeLessThanOrEqual(64);
		// Distinct long refs must not collapse to the same capped name.
		expect(directToolName("server", `${"t".repeat(80)}-other`)).not.toBe(long);
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

	test("renders structuredContent when a call returns no text content", async () => {
		const connector: McpConnector = async () => ({
			listTools: async () => [{ name: "data", inputSchema: { type: "object" } }],
			callTool: async () => ({ content: [], isError: false, structuredContent: { answer: 42 } }),
			close: async () => {},
		});
		const manager = managerWith(connector);
		const out = await callProxy(manager, { action: "call", server: "demo", tool: "data", arguments: {} });
		expect(out).toContain("answer");
		expect(out).toContain("42");
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
	test("reconnects once and retries when listing tools fails on a dead transport", async () => {
		let connectCount = 0;
		let failNextList = true;
		const connector: McpConnector = async () => {
			connectCount++;
			return {
				listTools: async () => {
					if (failNextList) {
						failNextList = false;
						throw new Error("transport closed");
					}
					return [{ name: "echo", inputSchema: { type: "object" } }];
				},
				callTool: async () => {
					return { content: [{ type: "text", text: "ok" }], isError: false };
				},
				close: async () => {},
			};
		};

		const manager = managerWith(connector);
		const result = await manager.listTools("demo");

		expect(result.map((tool) => tool.name)).toEqual(["echo"]);
		expect(connectCount).toBe(2);
	});

	test("does not retry tool calls after transport errors to avoid duplicate side effects", async () => {
		let connectCount = 0;
		let callCount = 0;
		const connector: McpConnector = async () => {
			connectCount++;
			return {
				listTools: async () => [{ name: "mutate", inputSchema: { type: "object" } }],
				callTool: async () => {
					callCount++;
					throw new Error("socket hang up");
				},
				close: async () => {},
			};
		};

		const manager = managerWith(connector);
		await expect(manager.callTool("demo", "mutate", {})).rejects.toThrow(/socket hang up/);
		expect(callCount).toBe(1);
		expect(connectCount).toBe(1);
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

	test("closes a connection that resolves after disconnect was requested", async () => {
		let closeCount = 0;
		let resolveConnect: ((client: McpClientLike) => void) | undefined;
		const pending = new Promise<McpClientLike>((resolve) => {
			resolveConnect = resolve;
		});
		const connector: McpConnector = async () => pending;

		const manager = managerWith(connector);
		const op = manager.listTools("demo").catch(() => undefined);
		const dis = manager.disconnectAll();
		resolveConnect?.({
			listTools: async () => [],
			callTool: async () => ({ content: [], isError: false }),
			close: async () => {
				closeCount++;
			},
		});
		await op;
		await dis;

		expect(closeCount).toBe(1);
		expect(manager.getStatus("demo")?.state).toBe("disconnected");
	});

	test("aborts an in-flight connect when disconnecting instead of waiting it out", async () => {
		let aborted = false;
		const connector: McpConnector = (_name, _config, signal) =>
			new Promise<McpClientLike>((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			});

		const manager = managerWith(connector);
		const op = manager.listTools("demo").catch(() => undefined);
		await manager.disconnect("demo");
		await op;

		expect(aborted).toBe(true);
	});

	test("a cancelled call stops waiting on a connect without aborting it for others", async () => {
		let connectAborted = false;
		let resolveConnect: ((client: McpClientLike) => void) | undefined;
		const pending = new Promise<McpClientLike>((resolve) => {
			resolveConnect = resolve;
		});
		const connector: McpConnector = (_name, _config, signal) => {
			signal?.addEventListener("abort", () => {
				connectAborted = true;
			});
			return pending;
		};

		const manager = managerWith(connector);
		const controller = new AbortController();
		const cancelled = manager.listTools("demo", controller.signal);
		controller.abort();
		await expect(cancelled).rejects.toThrow(/abort/i);
		// The shared connect must still be live for other callers.
		expect(connectAborted).toBe(false);

		resolveConnect?.({
			listTools: async () => [{ name: "echo", inputSchema: { type: "object" } }],
			callTool: async () => ({ content: [], isError: false }),
			close: async () => {},
		});
		const tools = await manager.listTools("demo");
		expect(tools.map((t) => t.name)).toEqual(["echo"]);
		await manager.disconnectAll();
	});

	test("treats inherited Object keys like toString as unknown servers", () => {
		const manager = managerWith(async () => inMemoryEchoClient());
		expect(manager.hasServer("toString")).toBe(false);
		expect(manager.hasServer("constructor")).toBe(false);
		expect(manager.hasServer("demo")).toBe(true);
	});

	test("does not double-end the old connection when reconnecting after a list failure cannot reconnect", async () => {
		let connectCount = 0;
		const closed: number[] = [];
		let releaseSlow!: () => void;
		let slowStarted!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const started = new Promise<void>((resolve) => {
			slowStarted = resolve;
		});
		const connector: McpConnector = async () => {
			connectCount++;
			const id = connectCount;
			if (id === 2) throw new Error("connection refused");
			return {
				listTools: async () => {
					throw new Error("transport closed");
				},
				callTool: async () => {
					slowStarted();
					await slowGate;
					return { content: [{ type: "text", text: `slow-${id}` }], isError: false };
				},
				close: async () => {
					closed.push(id);
				},
			};
		};

		const manager = managerWith(connector);
		const slow = manager.callTool("demo", "slow", {});
		await started;

		await expect(manager.listTools("demo")).rejects.toThrow(/connection refused/);
		expect(closed).not.toContain(1);

		releaseSlow();
		await expect(slow).resolves.toMatchObject({ isError: false });
		expect(closed.filter((id) => id === 1)).toEqual([1]);
	});

	test("passes the caller signal through reconnect waits", async () => {
		const connector: McpConnector = (_name, _config, signal) =>
			new Promise<McpClientLike>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const manager = managerWith(connector);
		const controller = new AbortController();
		controller.abort();

		const reconnect = manager.reconnect("demo", controller.signal);
		try {
			const outcome = await Promise.race([
				reconnect.then(
					() => "resolved",
					(error: unknown) => error,
				),
				new Promise<"pending">((resolve) => {
					setTimeout(() => resolve("pending"), 0);
				}),
			]);

			expect(outcome).toBeInstanceOf(Error);
			expect(String((outcome as Error).message)).toMatch(/abort/i);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("disconnect waits for in-flight operations before closing the client", async () => {
		let closeCount = 0;
		let releaseSlow!: () => void;
		let slowStarted!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const started = new Promise<void>((resolve) => {
			slowStarted = resolve;
		});
		const connector: McpConnector = async () => ({
			listTools: async () => [],
			callTool: async () => {
				slowStarted();
				await slowGate;
				return { content: [{ type: "text", text: "done" }], isError: false };
			},
			close: async () => {
				closeCount++;
			},
		});
		const manager = managerWith(connector);
		const slow = manager.callTool("demo", "slow", {});
		await started;

		await manager.disconnect("demo");
		expect(closeCount).toBe(0);

		releaseSlow();
		await expect(slow).resolves.toMatchObject({ isError: false });
		expect(closeCount).toBe(1);
	});

	test("a parallel call keeps its connection alive while a sibling list reconnects", async () => {
		let connectCount = 0;
		const closed: number[] = [];
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const connector: McpConnector = async () => {
			connectCount++;
			const id = connectCount;
			return {
				listTools: async () => {
					if (id === 1) throw new Error("transport closed");
					return [{ name: "ok", inputSchema: { type: "object" } }];
				},
				callTool: async (tool) => {
					if (tool === "slow") {
						await slowGate;
						return { content: [{ type: "text", text: `slow-${id}` }], isError: false };
					}
					return { content: [{ type: "text", text: `ok-${id}` }], isError: false };
				},
				close: async () => {
					closed.push(id);
				},
			};
		};

		const manager = managerWith(connector);
		// "slow" parks in-flight on connection 1; listTools forces a reconnect.
		const slow = manager.callTool("demo", "slow", {});
		const a = await manager.listTools("demo");

		expect(a.map((tool) => tool.name)).toEqual(["ok"]);
		// The slow sibling still holds connection 1, so it must not be closed yet.
		expect(closed).not.toContain(1);

		releaseSlow();
		const b = await slow;
		expect(b.isError).toBe(false);
		// Once the sibling drains, connection 1 is closed exactly once.
		expect(closed.filter((id) => id === 1)).toEqual([1]);
	});

	test("warns and skips when two directTools refs collide on a sanitized name", async () => {
		const connector: McpConnector = async () => ({
			listTools: async () => [
				{ name: "foo-bar", inputSchema: { type: "object" } },
				{ name: "foo_bar", inputSchema: { type: "object" } },
			],
			callTool: async () => ({ content: [], isError: false }),
			close: async () => {},
		});
		const manager = managerWith(connector);

		const registeredNames: string[] = [];
		const warnings: string[] = [];
		const pi = { registerTool: (tool: ToolDefinition) => registeredNames.push(tool.name) } as unknown as ExtensionAPI;

		await registerDirectTools(pi, manager, ["demo/foo-bar", "demo/foo_bar"], (m) => warnings.push(m));

		expect(registeredNames).toEqual(["mcp__demo__foo_bar"]);
		expect(warnings.some((w) => w.includes("collides"))).toBe(true);
		await manager.disconnectAll();
	});

	test("registers a deferred direct tool on connection errors and upgrades it on retry", async () => {
		let listToolsAvailable = false;
		const connector: McpConnector = async () => ({
			listTools: async () => {
				if (!listToolsAvailable) throw new Error("connection refused");
				return [
					{
						name: "echo",
						description: "Echo text",
						inputSchema: { type: "object", properties: { text: { type: "string" } } },
					},
				];
			},
			callTool: async () => ({ content: [{ type: "text", text: "called" }], isError: false }),
			close: async () => {},
		});
		const manager = managerWith(connector);

		const registeredTools: ToolDefinition[] = [];
		const warnings: string[] = [];
		const pi = { registerTool: (tool: ToolDefinition) => registeredTools.push(tool) } as unknown as ExtensionAPI;

		await registerDirectTools(pi, manager, ["demo/echo"], (m) => warnings.push(m));
		expect(registeredTools.map((tool) => tool.name)).toEqual(["mcp__demo__echo"]);
		expect(warnings.some((w) => w.includes("deferred schema"))).toBe(true);

		listToolsAvailable = true;
		await manager.reconnect("demo");
		await registerDirectTools(pi, manager, ["demo/echo"], (m) => warnings.push(m));

		expect(registeredTools.map((tool) => tool.name)).toEqual(["mcp__demo__echo", "mcp__demo__echo"]);
		expect(registeredTools[1]?.parameters).toEqual({
			type: "object",
			properties: { text: { type: "string" } },
		});
		await manager.disconnectAll();
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
