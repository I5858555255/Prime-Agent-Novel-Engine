import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const MAX_QUERIES = 5;
const SNIPPET_MAX_CHARS = 500;

const webSearchSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query." })),
	queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple search queries." })),
	maxResults: Type.Optional(
		Type.Number({
			description: `Maximum results per query. Defaults to ${DEFAULT_MAX_RESULTS}; capped at ${MAX_RESULTS}.`,
		}),
	),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;
export type WebSearchBackend = "exa-mcp";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	published?: string;
	author?: string;
}

export interface WebSearchQueryResult {
	query: string;
	backend: WebSearchBackend;
	results: WebSearchResult[];
}

export interface WebSearchToolDetails {
	queries: WebSearchQueryResult[];
}

interface ExaMcpTextContent {
	type?: string;
	text?: string;
}

interface ExaMcpResponse {
	result?: {
		content?: ExaMcpTextContent[];
	};
	error?: {
		code?: number;
		message?: string;
		data?: unknown;
	};
}

const HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function normalizeExaMcpResponse(value: unknown): ExaMcpResponse | undefined {
	if (!isRecord(value)) return undefined;
	if (!("result" in value) && !("error" in value)) return undefined;
	return value as ExaMcpResponse;
}

function parseSseDataMessages(body: string): unknown[] {
	const messages: unknown[] = [];
	let dataLines: string[] = [];

	function flush(): void {
		const data = dataLines.join("\n").trim();
		dataLines = [];
		if (!data || data === "[DONE]") return;
		const parsed = parseJson(data);
		if (parsed !== undefined) messages.push(parsed);
	}

	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trimStart());
		}
	}
	flush();

	return messages;
}

function parseExaMcpJsonRpc(body: string): ExaMcpResponse | undefined {
	const json = normalizeExaMcpResponse(parseJson(body.trim()));
	if (json) return json;

	for (const message of parseSseDataMessages(body)) {
		const response = normalizeExaMcpResponse(message);
		if (response) return response;
	}

	return undefined;
}

export function parseExaMcpResponse(body: string): string {
	const response = parseExaMcpJsonRpc(body);
	if (!response) {
		throw new Error("Invalid Exa MCP response.");
	}

	if (response.error) {
		const message = response.error.message || "unknown error";
		throw new Error(`Exa MCP search failed: ${message}`);
	}

	return (response.result?.content ?? [])
		.filter((content) => content.type === "text" && typeof content.text === "string")
		.map((content) => content.text)
		.join("\n\n")
		.trim();
}

function decodeHtmlEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity: string) => {
		if (entity.startsWith("#x")) {
			const codePoint = Number.parseInt(entity.slice(2), 16);
			return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		if (entity.startsWith("#")) {
			const codePoint = Number.parseInt(entity.slice(1), 10);
			return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		return HTML_ENTITIES[entity] ?? match;
	});
}

function isValidCodePoint(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function cleanText(text: string): string {
	return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}

function truncateSnippet(text: string): string {
	const cleaned = cleanText(text);
	if (cleaned.length <= SNIPPET_MAX_CHARS) return cleaned;
	return `${cleaned.slice(0, SNIPPET_MAX_CHARS - 3).trimEnd()}...`;
}

function canonicalFieldName(name: string): string {
	const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
	if (normalized === "published date") return "published";
	if (normalized === "highlight") return "highlights";
	return normalized;
}

const EXA_RESULT_FIELDS = new Set(["title", "url", "published", "author", "highlights", "text", "summary", "content"]);

function splitExaResultBlocks(text: string): string[] {
	const normalized = text.replace(/\r/g, "").trim();
	if (!normalized) return [];

	const blocks: string[] = [];
	for (const segment of normalized.split(/\n\s*-{3,}\s*\n/g)) {
		for (const block of segment.split(/\n(?=Title:\s*)/i)) {
			const trimmed = block.trim();
			if (trimmed && /^\s*(Title|URL):\s*/im.test(trimmed)) {
				blocks.push(trimmed);
			}
		}
	}
	return blocks;
}

function parseBlockFields(block: string): Map<string, string[]> {
	const fields = new Map<string, string[]>();
	let currentField: string | undefined;

	for (const rawLine of block.split("\n")) {
		const line = rawLine.trim();
		const fieldMatch = /^([A-Za-z][A-Za-z ]{0,30}):\s*(.*)$/.exec(line);
		if (fieldMatch) {
			const field = canonicalFieldName(fieldMatch[1]);
			if (EXA_RESULT_FIELDS.has(field)) {
				currentField = field;
				const values = fields.get(field) ?? [];
				if (fieldMatch[2]) values.push(fieldMatch[2]);
				fields.set(field, values);
				continue;
			}
		}

		if (currentField && line) {
			fields.get(currentField)?.push(line);
		}
	}

	return fields;
}

function firstField(fields: Map<string, string[]>, names: string[]): string | undefined {
	for (const name of names) {
		const value = fields.get(name);
		if (!value || value.length === 0) continue;
		const cleaned = cleanText(value.join("\n"));
		if (cleaned) return cleaned;
	}
	return undefined;
}

function fallbackSnippet(block: string): string {
	return block
		.split("\n")
		.filter((line) => !/^\s*(Title|URL|Published|Published Date|Author):\s*/i.test(line))
		.join("\n");
}

export function parseExaMcpResults(text: string): WebSearchResult[] {
	const results: WebSearchResult[] = [];

	for (const block of splitExaResultBlocks(text)) {
		const fields = parseBlockFields(block);
		const url = firstField(fields, ["url"]);
		if (!url) continue;

		const title = firstField(fields, ["title"]) ?? url;
		const snippet = truncateSnippet(
			firstField(fields, ["highlights", "text", "summary", "content"]) ?? fallbackSnippet(block),
		);
		const published = firstField(fields, ["published"]);
		const author = firstField(fields, ["author"]);

		results.push({
			title,
			url,
			snippet,
			...(published ? { published } : {}),
			...(author ? { author } : {}),
		});
	}

	return results;
}

function normalizeQueries(params: WebSearchToolInput): string[] {
	const queries = [params.query, ...(params.queries ?? [])]
		.filter((query): query is string => typeof query === "string")
		.map((query) => query.trim())
		.filter((query) => query.length > 0);

	if (queries.length === 0) {
		throw new Error("web_search requires `query` or `queries`.");
	}
	if (queries.length > MAX_QUERIES) {
		throw new Error(`web_search supports at most ${MAX_QUERIES} queries per call.`);
	}

	return Array.from(new Set(queries));
}

function normalizeMaxResults(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_RESULTS;
	if (!Number.isFinite(value) || value < 1) {
		throw new Error("web_search `maxResults` must be a positive number.");
	}
	return Math.min(Math.floor(value), MAX_RESULTS);
}

export async function searchExaMcp(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<WebSearchResult[]> {
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"User-Agent": "prime-agent-web-search/0.1",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search_exa",
				arguments: {
					query,
					numResults: maxResults,
					livecrawl: "fallback",
					type: "auto",
					contextMaxCharacters: 3000,
				},
			},
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`Exa MCP search failed with HTTP ${response.status}.`);
	}

	return parseExaMcpResults(parseExaMcpResponse(await response.text())).slice(0, maxResults);
}

function formatResults(results: WebSearchQueryResult[]): string {
	const sections: string[] = [];
	for (const queryResult of results) {
		const lines = [`Search results for "${queryResult.query}" (Exa MCP):`];
		if (queryResult.results.length === 0) {
			lines.push("", "No search results found.");
		} else {
			for (const [index, result] of queryResult.results.entries()) {
				lines.push("", `${index + 1}. ${result.title}`, `   ${result.url}`);
				if (result.snippet) lines.push(`   ${result.snippet}`);
			}
		}
		sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}

export function createWebSearchToolDefinition(): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web using Exa MCP without requiring a user API key. Use this for current events, recent " +
			"information, external documentation, or facts that may have changed. Cite source URLs in the final answer.",
		promptSnippet: "web_search - search the web with keyless Exa MCP; cite source URLs in the final answer",
		parameters: webSearchSchema,
		execute: async (_toolCallId, params, signal) => {
			const maxResults = normalizeMaxResults(params.maxResults);
			const queries = normalizeQueries(params);
			const queryResults: WebSearchQueryResult[] = [];

			for (const query of queries) {
				queryResults.push({
					query,
					backend: "exa-mcp",
					results: await searchExaMcp(query, maxResults, signal),
				});
			}

			return {
				content: [{ type: "text", text: formatResults(queryResults) }],
				details: { queries: queryResults },
			};
		},
	};
}

export function createWebSearchTool(): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition());
}
