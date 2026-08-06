import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

const model = getModel("anthropic", "claude-haiku-4-5");

describe("Anthropic unknown stop reason", () => {
	it("terminates via the structured failure path instead of crashing and preserves the raw reason", async () => {
		// A stop reason the SDK does not know yet. The stream delivered valid content,
		// so it must not be reported as successful completion and must not throw an
		// unhandled "Unhandled stop reason" error that bypasses stopReasonRaw.
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_unknown",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
			},
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hello" },
				}),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "content_filter_v2" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }] },
			{ client: createFakeAnthropicClient(response) },
		);
		const result = await stream.result();

		// Not reported as successful completion.
		expect(result.stopReason).toBe("error");
		// The raw provider value is preserved for post-mortem instead of being lost.
		expect(result.stopReasonRaw).toBe("content_filter_v2");
		// The structured failure path classifies the reason instead of surfacing a
		// raw "Unhandled stop reason: ..." implementation detail.
		expect(result.errorMessage).not.toContain("Unhandled stop reason");
	});
});
