/**
 * Promotes selected MCP tools to first-class Prime Agent tools.
 *
 * Most tools stay behind the `mcp` proxy to keep the prompt small, but a few
 * hot tools can be listed in `directTools` so the model sees their real schema
 * and can call them directly. pi validates tool arguments against raw JSON
 * Schema, so an MCP tool's `inputSchema` is used as the tool parameters as-is.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { parseToolRef } from "./config.js";
import type { McpManager, McpToolInfo } from "./manager.js";

const MAX_RESULT_CHARS = 20_000;

function truncate(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Output truncated: ${text.length} chars total.]`;
}

function renderContent(content: unknown): string {
	if (content == null) return "";
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

/**
 * Build a valid tool name like `mcp__server__tool`. Characters outside
 * `[A-Za-z0-9_]` are replaced, so distinct refs can in theory collide;
 * `registerDirectTools` detects and warns about that.
 */
export function directToolName(server: string, tool: string): string {
	const clean = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, "_");
	return `mcp__${clean(server)}__${clean(tool)}`;
}

export function buildDirectTool(manager: McpManager, server: string, info: McpToolInfo): ToolDefinition {
	return {
		name: directToolName(server, info.name),
		label: `${server}/${info.name}`,
		description: info.description ? `[MCP ${server}] ${info.description}` : `[MCP ${server}] Tool "${info.name}"`,
		parameters: info.inputSchema as unknown as TSchema,
		async execute(_toolCallId, params, signal) {
			const args = (params ?? {}) as Record<string, unknown>;
			const call = await manager.callTool(server, info.name, args, signal);
			const rendered = renderContent(call.content);
			if (call.isError) {
				throw new Error(rendered || `MCP tool ${server}/${info.name} returned an error`);
			}
			const structured = call.structuredContent ? JSON.stringify(call.structuredContent, null, 2) : "";
			return {
				content: [{ type: "text", text: truncate(rendered || structured || "(empty result)") }],
				details: { server, tool: info.name },
			};
		},
	};
}

/**
 * Resolve and register every `directTools` reference. Failures are logged and
 * skipped so a single bad server never blocks the rest of the extension.
 */
export async function registerDirectTools(
	pi: ExtensionAPI,
	manager: McpManager,
	refs: string[],
	logger: (message: string) => void,
	registered: Map<string, string> = new Map<string, string>(),
): Promise<void> {
	for (const ref of refs) {
		const parsed = parseToolRef(ref);
		if (!parsed) {
			logger(`Ignoring malformed directTools entry "${ref}" (expected "server/tool")`);
			continue;
		}
		if (!manager.hasServer(parsed.server)) {
			logger(`directTools entry "${ref}" references unknown server "${parsed.server}"`);
			continue;
		}

		try {
			const info = await manager.describeTool(parsed.server, parsed.tool);
			const name = directToolName(parsed.server, info.name);
			const owner = registered.get(name);
			if (owner !== undefined) {
				// Already promoted by this ref (idempotent reload), or a different
				// ref sanitized to the same tool name — warn so the collision is visible.
				if (owner !== ref) {
					logger(`directTools entry "${ref}" collides with "${owner}" as tool "${name}"; skipping`);
				}
				continue;
			}
			registered.set(name, ref);
			pi.registerTool(buildDirectTool(manager, parsed.server, info));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger(`Could not promote directTools entry "${ref}": ${message}`);
		}
	}
}
