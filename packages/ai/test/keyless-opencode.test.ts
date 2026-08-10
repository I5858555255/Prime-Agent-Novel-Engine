import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, isKeylessModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

// OpenCode Zen free-tier models (`opencode` provider, zero cost) accept requests
// with no API key and reject any non-empty Authorization header with 401, so the
// client must be built without an auth header. Regression guard for the keyless
// opencode support.

const mockState = vi.hoisted(() => ({
	lastClientOptions: undefined as unknown,
	lastParams: undefined as unknown,
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
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
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

describe("isKeylessModel", () => {
	it("returns true for zero-cost opencode models", () => {
		expect(isKeylessModel(getModel("opencode", "deepseek-v4-flash-free")!)).toBe(true);
	});

	it("returns false for paid opencode models", () => {
		expect(isKeylessModel(getModel("opencode", "kimi-k2.6")!)).toBe(false);
	});

	it("returns false for other providers", () => {
		expect(isKeylessModel(getModel("openai", "gpt-4o-mini")!)).toBe(false);
	});
});

describe("keyless opencode streaming", () => {
	beforeEach(() => {
		mockState.lastClientOptions = undefined;
		mockState.lastParams = undefined;
	});

	it("builds the client without an Authorization header for free opencode models", async () => {
		const model = getModel("opencode", "deepseek-v4-flash-free")!;

		await streamSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}).result();

		const options = mockState.lastClientOptions as {
			apiKey: string;
			baseURL: string;
			defaultHeaders: Record<string, string | null>;
		};
		expect(options.baseURL).toBe("https://opencode.ai/zen/v1");
		expect(options.defaultHeaders.Authorization).toBeNull();
	});

	it("rejects paid opencode models without a key", async () => {
		const model = getModel("opencode", "kimi-k2.6")!;

		const result = await streamSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("No API key for provider: opencode");
	});
});
