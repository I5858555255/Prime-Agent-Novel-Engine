/**
 * Promotes selected MCP tools to first-class Prime Agent tools.
 *
 * Most tools stay behind the `mcp` proxy to keep the prompt small, but a few
 * hot tools can be listed in `directTools` so the model sees their real schema
 * and can call them directly. pi validates tool arguments against raw JSON
 * Schema, so an MCP tool's `inputSchema` is used as the tool parameters as-is.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { parseToolRef } from "./config.js";
import { renderMcpCall } from "./content.js";
import type { McpManager, McpToolInfo } from "./manager.js";

// OpenAI-compatible providers cap tool names at 64 characters; exceed it and the
// whole request is rejected, not just the offending tool.
const MAX_TOOL_NAME = 64;

/**
 * Build a valid tool name like `mcp__server__tool`. Characters outside
 * `[A-Za-z0-9_]` are replaced, so distinct refs can in theory collide;
 * `registerDirectTools` detects and warns about that. Names longer than the
 * provider limit are truncated with a short hash of the original ref appended,
 * keeping them unique and stable.
 */
export function directToolName(server: string, tool: string): string {
	const clean = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, "_");
	const name = `mcp__${clean(server)}__${clean(tool)}`;
	if (name.length <= MAX_TOOL_NAME) return name;
	const hash = createHash("sha1").update(`${server}\u0000${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
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
			const rendered = renderMcpCall(call.content, call.structuredContent);
			if (call.isError) {
				throw new Error(rendered.text || `MCP tool ${server}/${info.name} returned an error`);
			}
			return {
				content: rendered.content,
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
	// `refs` arrives lowest-precedence first. Process highest first so that when
	// two distinct refs sanitize to the same tool name, the higher-precedence
	// (e.g. project) one wins and the lower-precedence one is the skipped collision.
	for (const ref of [...refs].reverse()) {
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
