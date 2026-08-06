import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model } from "../src/types.js";

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_xai_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(
		`data: ${JSON.stringify(event)}

data: [DONE]

`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

async function captureRequest(options: OpenAIResponsesOptions): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		captured = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
		};
		return completedResponse();
	});

	const model = getModel("xai", "grok-4.5") as Model<"openai-responses">;
	const context: Context = {
		systemPrompt: "You are a careful coding assistant.",
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
	};
	const result = await streamOpenAIResponses(model, context, options).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(captured).toBeDefined();
	return captured as CapturedRequest;
}

describe("xAI Responses routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses Responses with low, medium, and high reasoning for Grok 4.5", () => {
		const grok45 = getModel("xai", "grok-4.5");
		expect(grok45.api).toBe("openai-responses");
		expect(getSupportedThinkingLevels(grok45)).toEqual(["low", "medium", "high"]);
		expect(getModel("xai", "grok-4.3").api).toBe("openai-completions");
	});

	it("uses /responses with bearer auth and xAI-compatible request fields", async () => {
		const captured = await captureRequest({
			apiKey: "xai-test-token",
			sessionId: "prime-session-123",
			cacheRetention: "long",
			reasoningEffort: "medium",
		});

		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.headers.get("authorization")).toBe("Bearer xai-test-token");
		expect(captured.headers.get("session_id")).toBe("prime-session-123");
		expect(captured.body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			prompt_cache_key: "prime-session-123",
			reasoning: { effort: "medium" },
			include: ["reasoning.encrypted_content"],
		});
		expect(captured.body).not.toHaveProperty("prompt_cache_retention");
		expect(captured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "developer",
					content: "You are a careful coding assistant.",
				}),
			]),
		);
	});

	it("requests encrypted reasoning content without an explicit effort", async () => {
		const captured = await captureRequest({ apiKey: "xai-test-token" });
		expect(captured.body.include).toEqual(["reasoning.encrypted_content"]);
	});
});
