/**
 * Prime Agent MCP extension.
 *
 * Registers a single `mcp` proxy tool plus optional first-class `directTools`,
 * manages lazy connections to configured MCP servers, and adds a `/mcp` command
 * for status, tools, reconnect, and setup. See docs/mcp.md.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configCandidatePaths, loadMcpConfig } from "./config.js";
import { createDefaultConnector } from "./connector.js";
import { registerDirectTools } from "./direct-tools.js";
import { McpManager } from "./manager.js";
import { createMcpProxyTool } from "./proxy-tool.js";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export default function primeMcpExtension(pi: ExtensionAPI): void {
	// Persistent problems from loading config / promoting tools. Live connection
	// errors are not kept here; `/mcp status` reads those from the manager so they
	// reflect the current state instead of going stale.
	let configWarnings: string[] = [];
	const promoted = new Map<string, string>();
	let loadPromise: Promise<void> | undefined;

	const manager = new McpManager({ mcpServers: {}, directTools: [] }, { connector: createDefaultConnector() });

	pi.registerTool(createMcpProxyTool(manager));

	const doLoad = async (cwd: string): Promise<void> => {
		configWarnings = [];
		const loaded = await loadMcpConfig(cwd);
		configWarnings.push(...loaded.warnings);
		await manager.setConfig(loaded.config);
		if (loaded.config.directTools.length > 0) {
			await registerDirectTools(pi, manager, loaded.config.directTools, (m) => configWarnings.push(m), promoted);
		}
	};

	// Config (servers and promoted directTools) is resolved once, from the first
	// session's working directory. Promoted tools register globally and cannot be
	// unregistered, so reloading per session would risk leaving direct tools that
	// point at servers a later config removed. Restart to apply config changes.
	// Concurrent session starts share one load; a failed load is retried later.
	const loadOnce = (cwd: string): Promise<void> => {
		if (!loadPromise) {
			loadPromise = doLoad(cwd).catch((error) => {
				configWarnings.push(error instanceof Error ? error.message : String(error));
				loadPromise = undefined;
			});
		}
		return loadPromise;
	};

	pi.on("session_start", async (_event, ctx) => {
		await loadOnce(ctx.cwd);
		if (configWarnings.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`MCP: ${configWarnings.join("; ")}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await manager.disconnectAll();
	});

	pi.registerCommand("mcp", {
		description: "Manage MCP servers: status, tools [server], reconnect [server], setup",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["status", "tools", "reconnect", "setup"];
			const items = subcommands.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subcommand, target] = args.trim().split(/\s+/).filter(Boolean);

			switch (subcommand ?? "status") {
				case "status": {
					const statuses = manager.listStatuses();
					if (statuses.length === 0) {
						const base = "No MCP servers configured. Run /mcp setup.";
						const message = configWarnings.length > 0 ? `${base}\nwarnings: ${configWarnings.join("; ")}` : base;
						notify(ctx, message, configWarnings.length > 0 ? "warning" : "info");
						return;
					}
					const lines = statuses.map(
						(status) =>
							`${status.name}: ${status.state} (${status.transport})${
								status.toolCount !== undefined ? `, ${status.toolCount} tools` : ""
							}${status.error ? ` — ${status.error}` : ""}`,
					);
					if (configWarnings.length > 0) lines.push(`warnings: ${configWarnings.join("; ")}`);
					notify(ctx, lines.join("\n"), "info");
					return;
				}

				case "tools": {
					if (!target) {
						notify(ctx, "Usage: /mcp tools <server>", "warning");
						return;
					}
					if (!manager.hasServer(target)) {
						notify(ctx, `Unknown MCP server: ${target}`, "error");
						return;
					}
					try {
						const tools = await manager.listTools(target, ctx.signal);
						const lines = tools.map(
							(tool) => `- ${tool.name}${tool.description ? `: ${tool.description.split("\n")[0]}` : ""}`,
						);
						notify(
							ctx,
							lines.length > 0 ? `Tools on ${target}:\n${lines.join("\n")}` : `${target} exposes no tools.`,
							"info",
						);
					} catch (error) {
						notify(
							ctx,
							`Failed to list tools for ${target}: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
					return;
				}

				case "reconnect": {
					const targets = target ? [target] : manager.serverNames();
					if (target && !manager.hasServer(target)) {
						notify(ctx, `Unknown MCP server: ${target}`, "error");
						return;
					}
					if (targets.length === 0) {
						notify(ctx, "No MCP servers configured.", "info");
						return;
					}
					const reconnected: string[] = [];
					const failed: string[] = [];
					for (const name of targets) {
						try {
							await manager.reconnect(name, ctx.signal);
							reconnected.push(name);
						} catch (error) {
							failed.push(`${name} (${error instanceof Error ? error.message : String(error)})`);
						}
					}
					const parts: string[] = [];
					if (reconnected.length > 0) parts.push(`Reconnected: ${reconnected.join(", ")}`);
					if (failed.length > 0) parts.push(`Failed: ${failed.join(", ")}`);
					notify(ctx, parts.join("\n"), failed.length > 0 ? "error" : "info");
					return;
				}

				case "setup": {
					const paths = configCandidatePaths(ctx.cwd);
					const lines = [
						"MCP config is read from (highest precedence first):",
						...paths.map((path, index) => `  ${index + 1}. ${path}`),
						"",
						"Example mcp.json:",
						'{ "mcpServers": { "example": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } } }',
					];
					notify(ctx, lines.join("\n"), "info");
					return;
				}

				default:
					notify(ctx, `Unknown subcommand "${subcommand}". Use status, tools, reconnect, or setup.`, "warning");
			}
		},
	});
}
