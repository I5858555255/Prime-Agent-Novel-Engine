import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.js";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "test",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 10_000,
};

const context: Context = {
	messages: [{ role: "user", content: "Use the tool", timestamp: 1 }],
};

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createProxyResponse(events: ProxyAssistantMessageEvent[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createOpenProxyResponse(events: ProxyAssistantMessageEvent[]): Response {
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	const encodedBody = new TextEncoder().encode(body);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encodedBody);
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy tool arguments", () => {
	it("emits every raw delta and authoritatively finalizes complex JSON", async () => {
		const expected = {
			nested: { quote: 'say "hello"', path: "C:\\tmp", emoji: "🫠" },
			items: [1, true, null],
		};
		const json = JSON.stringify(expected);
		const deltas = json.split("");
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "tool-1", toolName: "edit" },
			...deltas.map(
				(delta): ProxyAssistantMessageEvent => ({
					type: "toolcall_delta",
					contentIndex: 0,
					delta,
				}),
			),
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse", usage },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createProxyResponse(events)),
		);
		const stream = streamProxy(model, context, {
			authToken: "test-token",
			proxyUrl: "https://proxy.test",
		});
		const emittedDeltas: string[] = [];

		for await (const event of stream) {
			if (event.type === "toolcall_delta") {
				emittedDeltas.push(event.delta);
			}
		}
		const result = await stream.result();

		expect(emittedDeltas).toEqual(deltas);
		expect(result.content).toEqual([{ type: "toolCall", id: "tool-1", name: "edit", arguments: expected }]);
		expect(result.content[0]).not.toHaveProperty("partialJson");
	});

	it("retains displayable tolerant arguments when the proxy stream is aborted", async () => {
		const controller = new AbortController();
		const deltas = ['{"first":"materialized"', ',"x":1}'];
		expect(deltas.map((delta) => delta.length)).toEqual([23, 7]);
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "tool-1", toolName: "edit" },
			...deltas.map(
				(delta): ProxyAssistantMessageEvent => ({
					type: "toolcall_delta",
					contentIndex: 0,
					delta,
				}),
			),
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => createOpenProxyResponse(events)),
		);
		const stream = streamProxy(model, context, {
			authToken: "test-token",
			proxyUrl: "https://proxy.test",
			signal: controller.signal,
		});
		const seenEvents: AssistantMessageEvent[] = [];
		let seenDeltaCount = 0;

		for await (const event of stream) {
			seenEvents.push(event);
			if (event.type === "toolcall_delta") {
				seenDeltaCount += 1;
				if (seenDeltaCount === deltas.length) {
					controller.abort();
				}
			}
		}
		const result = await stream.result();

		expect(seenEvents.filter((event) => event.type === "toolcall_delta").map((event) => event.delta)).toEqual(deltas);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request aborted by user");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { first: "materialized", x: 1 },
		});
	});
});
