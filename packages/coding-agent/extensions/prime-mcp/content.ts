/**
 * Render MCP tool call results into Prime Agent tool content.
 *
 * MCP results carry an array of typed content blocks (text, image, audio,
 * resource links, embedded resources) plus optional `structuredContent`. The
 * proxy tool and promoted direct tools share this so non-text payloads (notably
 * images) reach the model instead of being flattened to a placeholder. Block
 * order is preserved so captions stay attached to the right image.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const MAX_TEXT_CHARS = 20_000;

export type ToolContent = TextContent | ImageContent;

export interface RenderedCall {
	/** Full content (text + images) for an AgentToolResult, in original order. */
	content: ToolContent[];
	/** Plain-text summary, used for error messages. */
	text: string;
}

interface EmbeddedResource {
	uri?: string;
	text?: string;
	blob?: string;
	mimeType?: string;
	name?: string;
}

interface McpBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	name?: string;
	description?: string;
	resource?: EmbeddedResource;
}

function truncate(text: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Output truncated: ${text.length} chars total. Call the tool with narrower arguments for less output.]`;
}

function normalizeBlocks(content: unknown): Array<McpBlock | null | undefined> {
	if (content == null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as Array<McpBlock | null | undefined>;
	return [{ type: "_json" }];
}

function isImageMime(mimeType: string | undefined): mimeType is string {
	return typeof mimeType === "string" && mimeType.startsWith("image/");
}

function resourceLinkLine(block: McpBlock): string {
	const suffix = block.description ? ` — ${block.description}` : "";
	if (block.name && block.uri) return `[resource_link] ${block.name}: ${block.uri}${suffix}`;
	const label = block.name ?? block.uri ?? "resource";
	return `[resource_link] ${label}${suffix}`;
}

function embeddedResourceLine(resource: EmbeddedResource): string {
	if (resource.name && resource.uri) return `[resource] ${resource.name}: ${resource.uri}`;
	const label = resource.name ?? resource.uri;
	return label ? `[resource] ${label}` : "[resource]";
}

/** Convert an MCP content array (with structuredContent fallback) to tool content. */
export function renderMcpCall(content: unknown, structuredContent?: unknown): RenderedCall {
	const out: ToolContent[] = [];
	const textSummary: string[] = [];
	let buffer: string[] = [];

	const flush = (): void => {
		if (buffer.length === 0) return;
		out.push({ type: "text", text: truncate(buffer.join("\n")) });
		buffer = [];
	};
	const pushText = (text: string): void => {
		buffer.push(text);
		textSummary.push(text);
	};
	const pushImage = (data: string, mimeType: string): void => {
		flush();
		out.push({ type: "image", data, mimeType });
	};

	for (const block of normalizeBlocks(content)) {
		if (block == null) continue;
		switch (block.type) {
			case "text":
				if (typeof block.text === "string") pushText(block.text);
				break;
			case "image":
				if (typeof block.data === "string" && typeof block.mimeType === "string") {
					pushImage(block.data, block.mimeType);
				} else {
					pushText("[image content]");
				}
				break;
			case "audio":
				pushText(block.mimeType ? `[audio content: ${block.mimeType}]` : "[audio content]");
				break;
			case "resource_link":
				pushText(resourceLinkLine(block));
				break;
			case "resource": {
				const resource = block.resource;
				if (resource?.blob && isImageMime(resource.mimeType)) {
					pushImage(resource.blob, resource.mimeType);
				} else if (typeof resource?.text === "string") {
					pushText(resource.text);
				} else if (resource) {
					pushText(embeddedResourceLine(resource));
				} else {
					pushText("[resource]");
				}
				break;
			}
			case "_json":
				pushText(JSON.stringify(content, null, 2));
				break;
			default:
				pushText(JSON.stringify(block));
		}
	}
	flush();

	let text = textSummary.join("\n");
	if (out.length === 0 && structuredContent !== undefined) {
		text = JSON.stringify(structuredContent, null, 2);
		out.push({ type: "text", text: truncate(text) });
	}
	if (out.length === 0) out.push({ type: "text", text: "(empty result)" });

	// `text` feeds thrown error messages, which the agent loop turns into tool
	// result content verbatim; bound it so a huge error payload can't blow past
	// the output cap the content blocks already respect.
	return { content: out, text: truncate(text) };
}
