import { afterEach, describe, expect, it, vi } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { AssistantMessage, Context, ToolResultMessage, Usage } from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function consume(stream: ReturnType<typeof streamOpenAIResponses>): Promise<void> {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
}

describe("Meta Model API", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("registers Muse Spark models with official limits, pricing, and reasoning levels", () => {
		expect(getModels("meta").map((model) => model.id)).toEqual([
			"muse-spark-1.1",
			"muse-spark-1.2",
			"muse-spark-1.2-contributor",
		]);

		const standard = getModel("meta", "muse-spark-1.2");
		expect(standard).toMatchObject({
			api: "openai-responses",
			provider: "meta",
			baseUrl: "https://api.meta.ai/v1",
			reasoning: true,
			thinkingLevelMap: { off: null, xhigh: "xhigh" },
			input: ["text", "image"],
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 131072,
			compat: { sendSessionIdHeader: false },
		});
		expect(standard.thinkingLevelMap).not.toHaveProperty("max");
		expect(getSupportedThinkingLevels(standard)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);

		expect(getModel("meta", "muse-spark-1.1").maxTokens).toBe(131072);
		expect(getModel("meta", "muse-spark-1.2-contributor").cost).toEqual({
			input: 0.1,
			output: 0.2,
			cacheRead: 0.002,
			cacheWrite: 0,
		});
	});

	it("uses the official MODEL_API_KEY environment variable", () => {
		vi.stubEnv("MODEL_API_KEY", "meta-test-key");
		expect(getEnvApiKey("meta")).toBe("meta-test-key");
	});

	it("omits unrequested reasoning parameters and the session header while preserving native tool IDs", async () => {
		const model = getModel("meta", "muse-spark-1.2");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_meta|fc_meta", name: "lookup", arguments: { value: 1 } }],
			api: "openai-responses",
			provider: "meta",
			model: "muse-spark-1.1",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: Date.now() - 1000,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_meta|fc_meta",
			toolName: "lookup",
			content: [{ type: "text", text: "1" }],
			isError: false,
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [{ role: "user", content: "Look this up", timestamp: Date.now() - 2000 }, assistant, toolResult],
		};
		let payload: unknown;
		let sessionHeader: string | null = null;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			sessionHeader = new Headers(init?.headers).get("session_id");
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const stream = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			sessionId: "session-123",
			onPayload: (value) => {
				payload = value;
			},
		});
		await consume(stream);

		expect(sessionHeader).toBeNull();
		expect(payload).not.toMatchObject({ reasoning: expect.anything() });
		expect(payload).toMatchObject({
			include: ["reasoning.encrypted_content"],
			input: expect.arrayContaining([expect.objectContaining({ type: "function_call", call_id: "call_meta" })]),
		});
	});

	it("does not send an OpenAI API key to Meta when MODEL_API_KEY is missing", async () => {
		vi.stubEnv("MODEL_API_KEY", "");
		vi.stubEnv("OPENAI_API_KEY", "openai-secret");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const result = await streamOpenAIResponses(getModel("meta", "muse-spark-1.2"), {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("MODEL_API_KEY");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends xhigh reasoning with encrypted reasoning content enabled", async () => {
		const model = getModel("meta", "muse-spark-1.2");
		let payload: unknown;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: "test-key",
				reasoningEffort: "xhigh",
				onPayload: (value) => {
					payload = value;
				},
			},
		);
		await consume(stream);

		expect(payload).toMatchObject({
			reasoning: { effort: "xhigh", summary: "auto" },
			include: ["reasoning.encrypted_content"],
		});
	});

	it("does not apply OpenAI service-tier price multipliers", async () => {
		const model = getModel("meta", "muse-spark-1.2");
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				service_tier: "priority",
				usage: {
					input_tokens: 1000000,
					output_tokens: 1000000,
					total_tokens: 2000000,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}\n\n`;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const result = await streamOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", serviceTier: "priority" },
		).result();

		expect(result.usage.cost).toMatchObject({ input: 1.25, output: 4.25, total: 5.5 });
	});
});
