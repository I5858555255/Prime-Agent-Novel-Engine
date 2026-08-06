import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels } from "../src/models.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";

interface FakeOpenAIClientOptions {
	apiKey?: string;
	baseURL?: string;
	dangerouslyAllowBrowser?: boolean;
	defaultHeaders?: Record<string, string>;
}

const mockState = vi.hoisted(() => ({
	clientOptions: undefined as FakeOpenAIClientOptions | undefined,
	payload: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: Record<string, unknown>) => {
					mockState.payload = params;
					const chunks: Record<string, unknown>[] = [
						{
							id: "chatcmpl-celeris-test",
							model: "celeris-1",
							choices: [{ delta: { content: "OK" }, finish_reason: null }],
						},
						{
							id: "chatcmpl-celeris-test",
							model: "celeris-1",
							choices: [{ delta: {}, finish_reason: "stop" }],
						},
						{
							id: "chatcmpl-celeris-test",
							model: "celeris-1",
							choices: [],
							usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
						},
					];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};

		constructor(options: FakeOpenAIClientOptions) {
			mockState.clientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

describe("Celeris", () => {
	beforeEach(() => {
		mockState.clientOptions = undefined;
		mockState.payload = undefined;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("registers Celeris 1 with official API metadata", () => {
		expect(getModels("celeris").map((model) => model.id)).toEqual(["celeris-1"]);
		expect(getModel("celeris", "celeris-1")).toMatchObject({
			id: "celeris-1",
			name: "Celeris 1",
			api: "openai-completions",
			provider: "celeris",
			baseUrl: "https://inference.celeris.ai/celeris-1/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.2, output: 0.7, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 131072,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
			},
		});
	});

	it("resolves CELERIS_API_KEY from the environment", () => {
		vi.stubEnv("CELERIS_API_KEY", "ck_celeris-test");

		expect(findEnvKeys("celeris")).toEqual(["CELERIS_API_KEY"]);
		expect(getEnvApiKey("celeris")).toBe("ck_celeris-test");
	});

	it("uses Celeris's documented 2,048-token default output budget", async () => {
		await streamSimpleOpenAICompletions(
			getModel("celeris", "celeris-1"),
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ apiKey: "ck_explicit" },
		).result();

		expect(mockState.payload?.max_tokens).toBe(2048);
		expect(mockState.payload).not.toHaveProperty("max_completion_tokens");
	});

	it("rejects tool choices that Celeris does not support", async () => {
		const result = await streamOpenAICompletions(
			getModel("celeris", "celeris-1"),
			{ messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
			{ apiKey: "ck_explicit", toolChoice: "required" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('tool_choice supports only "auto" or "none"');
		expect(mockState.payload).toBeUndefined();
	});

	it("sends only the documented OpenAI-compatible request fields", async () => {
		const model = getModel("celeris", "celeris-1");
		const result = await streamOpenAICompletions(
			model,
			{
				systemPrompt: "Use the lookup tool.",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "What is shown?" },
							{ type: "image", data: "AA==", mimeType: "image/png" },
						],
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "lookup",
						description: "Look up a value",
						parameters: Type.Object({ query: Type.String() }),
					},
				],
			},
			{
				apiKey: "ck_explicit",
				maxTokens: 256,
				cacheRetention: "long",
				sessionId: "session-celeris",
			},
		).result();

		expect(mockState.clientOptions).toMatchObject({
			apiKey: "ck_explicit",
			baseURL: "https://inference.celeris.ai/celeris-1/v1",
			dangerouslyAllowBrowser: true,
		});
		expect(mockState.clientOptions?.defaultHeaders).toEqual({});
		expect(mockState.payload).toMatchObject({
			model: "celeris-1",
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 256,
			messages: [
				{ role: "system", content: "Use the lookup tool." },
				{
					role: "user",
					content: [
						{ type: "text", text: "What is shown?" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
					],
				},
			],
		});
		expect(mockState.payload).not.toHaveProperty("max_completion_tokens");
		expect(mockState.payload).not.toHaveProperty("store");
		expect(mockState.payload).not.toHaveProperty("reasoning_effort");
		expect(mockState.payload?.prompt_cache_key).toBeUndefined();
		expect(mockState.payload?.prompt_cache_retention).toBeUndefined();

		const tools = mockState.payload?.tools as Array<{ function?: Record<string, unknown> }> | undefined;
		expect(tools).toHaveLength(1);
		expect(tools?.[0]?.function).toMatchObject({
			name: "lookup",
			description: "Look up a value",
		});
		expect(tools?.[0]?.function).not.toHaveProperty("strict");
		expect(result).toMatchObject({
			stopReason: "stop",
			responseId: "chatcmpl-celeris-test",
			content: [{ type: "text", text: "OK" }],
			usage: { input: 10, output: 2, totalTokens: 12 },
		});
		expect(result.usage.cost.input).toBeCloseTo(0.000002);
		expect(result.usage.cost.output).toBeCloseTo(0.0000014);
	});

	it("does not send OPENAI_API_KEY when CELERIS_API_KEY is missing", async () => {
		vi.stubEnv("CELERIS_API_KEY", "");
		vi.stubEnv("OPENAI_API_KEY", "openai-secret");

		const result = await streamOpenAICompletions(getModel("celeris", "celeris-1"), {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("CELERIS_API_KEY");
		expect(mockState.clientOptions).toBeUndefined();
		expect(mockState.payload).toBeUndefined();
	});
});
