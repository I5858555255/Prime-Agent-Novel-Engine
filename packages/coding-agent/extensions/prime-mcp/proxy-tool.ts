/**
 * The `mcp` proxy tool: a single tool the model uses to discover and call tools
 * across every configured MCP server. Keeping one tool in the prompt avoids
 * loading every server's full tool schema into context up front.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpManager, McpToolInfo } from "./manager.js";

const MAX_RESULT_CHARS = 20_000;

const McpProxyParams = Type.Object({
	action: StringEnum(["list_servers", "list_tools", "describe", "call"] as const, {
		description:
			"list_servers: show configured servers; list_tools: list a server's tools; describe: show one tool's input schema; call: invoke a tool",
	}),
	server: Type.Optional(Type.String({ description: "Server name (required for list_tools, describe, call)" })),
	tool: Type.Optional(Type.String({ description: "Tool name (required for describe and call)" })),
	arguments: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Arguments object passed to the tool (for call)" }),
	),
});

export type McpProxyInput = {
	action: "list_servers" | "list_tools" | "describe" | "call";
	server?: string;
	tool?: string;
	arguments?: Record<string, unknown>;
};

export interface McpProxyDetails {
	action: string;
	server?: string;
	tool?: string;
}

function truncate(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Output truncated: ${text.length} chars total. Call the tool with narrower arguments for less output.]`;
}

function summarizeTool(tool: McpToolInfo): string {
	const description = tool.description?.split("\n")[0]?.trim();
	return description ? `${tool.name} — ${description}` : tool.name;
}

function renderCallContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content, null, 2);

	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block) {
			const typed = block as { type: string; text?: string };
			if (typed.type === "text" && typeof typed.text === "string") {
				parts.push(typed.text);
				continue;
			}
			parts.push(`[${typed.type} content]`);
			continue;
		}
		parts.push(JSON.stringify(block));
	}
	return parts.join("\n");
}

function result(text: string, details: McpProxyDetails) {
	return { content: [{ type: "text" as const, text: truncate(text) }], details };
}

export function createMcpProxyTool(manager: McpManager): ToolDefinition<typeof McpProxyParams, McpProxyDetails> {
	return {
		name: "mcp",
		label: "MCP",
		description:
			"Discover and call tools on external MCP (Model Context Protocol) servers. Use action=list_servers to see what is available, list_tools to see a server's tools, describe to read a tool's input schema, and call to invoke a tool. Prefer describe before call so arguments match the schema.",
		promptGuidelines: [
			"Use the mcp tool to reach external MCP servers; start with action=list_servers, then list_tools and describe before action=call.",
		],
		parameters: McpProxyParams,
		async execute(_toolCallId, params, signal) {
			switch (params.action) {
				case "list_servers": {
					const statuses = manager.listStatuses();
					if (statuses.length === 0) {
						return result(
							"No MCP servers are configured. Add servers to .mcp.json or ~/.prime/agent/mcp.json (see /mcp setup).",
							{ action: params.action },
						);
					}
					const lines = statuses.map(
						(status) =>
							`- ${status.name} (${status.transport}, ${status.state}${
								status.toolCount !== undefined ? `, ${status.toolCount} tools` : ""
							})${status.error ? ` — ${status.error}` : ""}`,
					);
					return result(`Configured MCP servers:\n${lines.join("\n")}`, { action: params.action });
				}

				case "list_tools": {
					if (!params.server) throw new Error("action=list_tools requires a server");
					const tools = await manager.listTools(params.server, signal);
					if (tools.length === 0) {
						return result(`Server "${params.server}" exposes no tools.`, {
							action: params.action,
							server: params.server,
						});
					}
					const lines = tools.map((tool) => `- ${summarizeTool(tool)}`);
					return result(`Tools on "${params.server}":\n${lines.join("\n")}`, {
						action: params.action,
						server: params.server,
					});
				}

				case "describe": {
					if (!params.server) throw new Error("action=describe requires a server");
					if (!params.tool) throw new Error("action=describe requires a tool");
					const tool = await manager.describeTool(params.server, params.tool, signal);
					const text = [
						`${params.server}/${tool.name}`,
						tool.description ?? "(no description)",
						"",
						"Input schema:",
						JSON.stringify(tool.inputSchema, null, 2),
					].join("\n");
					return result(text, { action: params.action, server: params.server, tool: params.tool });
				}

				case "call": {
					if (!params.server) throw new Error("action=call requires a server");
					if (!params.tool) throw new Error("action=call requires a tool");
					const call = await manager.callTool(params.server, params.tool, params.arguments, signal);
					const rendered = renderCallContent(call.content);
					// Surface MCP tool errors as tool errors so the agent loop flags them,
					// matching how promoted directTools behave.
					if (call.isError) {
						throw new Error(rendered || `MCP tool ${params.server}/${params.tool} returned an error`);
					}
					return result(rendered || "(empty result)", {
						action: params.action,
						server: params.server,
						tool: params.tool,
					});
				}
			}
		},
	};
}
