import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import {
	createWebSearchToolDefinition,
	parseExaMcpResponse,
	parseExaMcpResults,
} from "../src/core/tools/web-search.js";

function exaPayload(text: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: {
			content: [{ type: "text", text }],
		},
	});
}

describe("web_search tool", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("parses Exa MCP SSE responses", () => {
		const text = "Title: Prime Agent\nURL: https://example.com\nHighlights:\nA result.";
		const body = `event: message\ndata: ${exaPayload(text)}\n\n`;

		expect(parseExaMcpResponse(body)).toBe(text);
	});

	test("parses Exa result blocks", () => {
		const results = parseExaMcpResults(`
Title: Prime &amp; Agent
URL: https://example.com/prime
Published Date: 2026-05-15
Author: Prime Team
Highlights:
Search &quot;works&quot; without an API key.
---
Title: Docs
URL: https://example.com/docs
Text:
Use &lt;web_search&gt; for current facts.
---
Title: Malformed Entity
URL: https://example.com/entity
Text:
Broken &#xD800; entity remains encoded.
`);

		expect(results).toEqual([
			{
				title: "Prime & Agent",
				url: "https://example.com/prime",
				published: "2026-05-15",
				author: "Prime Team",
				snippet: 'Search "works" without an API key.',
			},
			{
				title: "Docs",
				url: "https://example.com/docs",
				snippet: "Use <web_search> for current facts.",
			},
			{
				title: "Malformed Entity",
				url: "https://example.com/entity",
				snippet: "Broken &#xD800; entity remains encoded.",
			},
		]);
	});

	test("executes searches through Exa MCP", async () => {
		const requests: unknown[] = [];
		const fetchMock: typeof fetch = async (_input, init) => {
			if (typeof init?.body !== "string") {
				throw new Error("expected string request body");
			}
			requests.push(JSON.parse(init.body));
			return new Response(
				`event: message\ndata: ${exaPayload("Title: Result\nURL: https://example.com\nHighlights:\nFound it.")}\n\n`,
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		};
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchToolDefinition();
		const result = await tool.execute(
			"tool-call",
			{ query: "prime agent", maxResults: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "web_search_exa",
				arguments: {
					query: "prime agent",
					numResults: 1,
					livecrawl: "fallback",
					type: "auto",
				},
			},
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: 'Search results for "prime agent" (Exa MCP):\n\n1. Result\n   https://example.com\n   Found it.',
			},
		]);
		expect(result.details).toEqual({
			queries: [
				{
					query: "prime agent",
					backend: "exa-mcp",
					results: [{ title: "Result", url: "https://example.com", snippet: "Found it." }],
				},
			],
		});
	});

	test("deduplicates queries before enforcing the per-call query limit", async () => {
		const requests: unknown[] = [];
		const fetchMock: typeof fetch = async (_input, init) => {
			if (typeof init?.body !== "string") {
				throw new Error("expected string request body");
			}
			requests.push(JSON.parse(init.body));
			return new Response(
				`event: message\ndata: ${exaPayload("Title: Result\nURL: https://example.com\nHighlights:\nFound it.")}\n\n`,
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		};
		vi.stubGlobal("fetch", fetchMock);

		const tool = createWebSearchToolDefinition();
		const result = await tool.execute(
			"tool-call",
			{ query: "prime agent", queries: Array(5).fill(" prime agent ") },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(requests).toHaveLength(1);
		expect(result.details.queries.map((query) => query.query)).toEqual(["prime agent"]);
	});

	test("rejects empty queries before searching", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("fetch should not be called");
		});

		const tool = createWebSearchToolDefinition();
		await expect(
			tool.execute("tool-call", { query: "   " }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("web_search requires `query` or `queries`.");
	});
});
