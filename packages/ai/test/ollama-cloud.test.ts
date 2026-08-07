import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Tool } from "../src/types.js";

type MockChunk = {
	choices: Array<{
		delta: Record<string, unknown>;
		finish_reason: string | null;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		prompt_tokens_details: { cached_tokens: number };
		completion_tokens_details: { reasoning_tokens: number };
	};
};

const mockState = vi.hoisted(() => ({
	lastClientOptions: undefined as unknown,
	lastParams: undefined as unknown,
	chunks: [] as MockChunk[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks) yield chunk;
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
	}

	return { default: FakeOpenAI };
});

describe("Ollama Cloud", () => {
	beforeEach(() => {
		mockState.lastClientOptions = undefined;
		mockState.lastParams = undefined;
		mockState.chunks = [
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "ping", arguments: '{"ok":true}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				choices: [{ delta: {}, finish_reason: "tool_calls" }],
				usage: {
					prompt_tokens: 11,
					completion_tokens: 7,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];
	});

	afterEach(() => {
		delete process.env.OLLAMA_API_KEY;
	});

	it("registers the default Cloud model with the required compatibility contract", () => {
		const model = getModel("ollama-cloud", "glm-5.2");
		const ids = getModels("ollama-cloud").map((candidate) => candidate.id);

		expect(getModels("ollama-cloud")).toContain(model);
		expect(ids).toEqual([
			"deepseek-v4-flash:0731",
			"deepseek-v4-flash:preview",
			"deepseek-v4-pro",
			"gemma4:31b",
			"glm-5.1",
			"glm-5.2",
			"gpt-oss:120b",
			"gpt-oss:20b",
			"kimi-k2.6",
			"kimi-k2.7-code",
			"kimi-k3",
			"minimax-m2.7",
			"minimax-m3",
			"mistral-large-3:675b",
			"nemotron-3-nano:30b",
			"nemotron-3-super",
			"nemotron-3-ultra",
			"qwen3.5:397b",
		]);
		expect(model).toMatchObject({
			id: "glm-5.2",
			contextWindow: 976000,
			maxTokens: 131072,
		});
		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com/v1",
			reasoning: true,
			thinkingLevelMap: { off: "none" },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
			},
		});
	});

	it("resolves OLLAMA_API_KEY", () => {
		process.env.OLLAMA_API_KEY = "test-ollama-key";

		expect(findEnvKeys("ollama-cloud")).toEqual(["OLLAMA_API_KEY"]);
		expect(getEnvApiKey("ollama-cloud")).toBe("test-ollama-key");
	});

	it("uses Ollama-compatible request fields and preserves streamed tool calls", async () => {
		const tools: Tool[] = [
			{
				name: "ping",
				description: "Ping a service.",
				parameters: Type.Object({ ok: Type.Boolean() }),
			},
		];

		const message = await streamSimple(
			getModel("ollama-cloud", "gpt-oss:120b"),
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Call ping.", timestamp: 1 }],
				tools,
			},
			{ apiKey: "test-ollama-key", maxTokens: 123, cacheRetention: "long", sessionId: "test-session" },
		).result();

		const params = mockState.lastParams as {
			messages: Array<{ role: string }>;
			max_tokens?: number;
			max_completion_tokens?: number;
			prompt_cache_retention?: string;
			reasoning_effort?: string;
			store?: boolean;
			tools?: Array<{ function?: { strict?: boolean } }>;
		};
		const clientOptions = mockState.lastClientOptions as { apiKey?: string; baseURL?: string };

		expect(clientOptions).toMatchObject({ apiKey: "test-ollama-key", baseURL: "https://ollama.com/v1" });
		expect(params.messages[0]?.role).toBe("system");
		expect(params.max_tokens).toBe(123);
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.prompt_cache_retention).toBeUndefined();
		expect(params.reasoning_effort).toBe("none");
		expect(params.store).toBeUndefined();
		expect(params.tools?.[0]?.function?.strict).toBeUndefined();
		expect(message).toMatchObject({
			stopReason: "toolUse",
			usage: { input: 11, output: 7, totalTokens: 18 },
			content: [{ type: "toolCall", id: "call_1", name: "ping", arguments: { ok: true } }],
		});
	});
});
