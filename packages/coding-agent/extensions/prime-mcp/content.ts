/**
 * Render MCP tool call results into Prime Agent tool content.
 *
 * MCP results carry an array of typed content blocks (text, image, audio,
 * resource links, embedded resources) plus optional `structuredContent`. The
 * proxy tool and promoted direct tools share this so non-text payloads (notably
 * images) reach the model instead of being flattened to a placeholder.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const MAX_TEXT_CHARS = 20_000;

export type ToolContent = TextContent | ImageContent;

export interface RenderedCall {
	/** Full content (text + images) for an AgentToolResult. */
	content: ToolContent[];
	/** Plain-text summary, used for error messages. */
	text: string;
}

interface McpBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	name?: string;
	description?: string;
	resource?: { uri?: string; text?: string; blob?: string; mimeType?: string; name?: string };
}

function truncate(text: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Output truncated: ${text.length} chars total. Call the tool with narrower arguments for less output.]`;
}

function normalizeBlocks(content: unknown): McpBlock[] {
	if (content == null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as McpBlock[];
	return [{ type: "_json" }];
}

function renderResourceLink(block: McpBlock): string {
	const label = block.name ?? block.uri ?? "resource";
	const suffix = block.description ? ` — ${block.description}` : "";
	return block.uri ? `[resource_link] ${label}: ${block.uri}${suffix}` : `[resource_link] ${label}${suffix}`;
}

function renderEmbeddedResource(block: McpBlock): string {
	const resource = block.resource;
	if (!resource) return "[resource]";
	if (typeof resource.text === "string") return resource.text;
	if (resource.uri) return `[resource] ${resource.name ?? resource.uri}: ${resource.uri}`;
	return "[resource]";
}

/** Convert an MCP content array (with structuredContent fallback) to tool content. */
export function renderMcpCall(content: unknown, structuredContent?: Record<string, unknown>): RenderedCall {
	const textParts: string[] = [];
	const images: ImageContent[] = [];

	for (const block of normalizeBlocks(content)) {
		switch (block.type) {
			case "text":
				if (typeof block.text === "string") textParts.push(block.text);
				break;
			case "image":
				if (typeof block.data === "string" && typeof block.mimeType === "string") {
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				} else {
					textParts.push("[image content]");
				}
				break;
			case "audio":
				textParts.push(block.mimeType ? `[audio content: ${block.mimeType}]` : "[audio content]");
				break;
			case "resource_link":
				textParts.push(renderResourceLink(block));
				break;
			case "resource":
				textParts.push(renderEmbeddedResource(block));
				break;
			case "_json":
				textParts.push(JSON.stringify(content, null, 2));
				break;
			default:
				textParts.push(JSON.stringify(block));
		}
	}

	let text = textParts.join("\n");
	if (!text && structuredContent) text = JSON.stringify(structuredContent, null, 2);

	const out: ToolContent[] = [];
	if (text) out.push({ type: "text", text: truncate(text) });
	out.push(...images);
	if (out.length === 0) out.push({ type: "text", text: "(empty result)" });

	return { content: out, text };
}
