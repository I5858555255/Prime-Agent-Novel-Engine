import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";

const originalPrimeApiKey = process.env.PRIME_API_KEY;

afterEach(() => {
	if (originalPrimeApiKey === undefined) {
		delete process.env.PRIME_API_KEY;
	} else {
		process.env.PRIME_API_KEY = originalPrimeApiKey;
	}
});

describe("Prime Inference models", () => {
	it("registers the Prime Inference catalog snapshot", () => {
		const modelIds = getModels("prime-inference").map((model) => model.id);

		expect(modelIds.length).toBeGreaterThanOrEqual(100);
		expect(modelIds).toEqual(
			expect.arrayContaining([
				"anthropic/claude-opus-4.7",
				"openai/gpt-5.2-pro",
				"openai/gpt-5.4",
				"openai/gpt-5.5",
				"prime-intellect/intellect-3",
				"qwen/qwen3-vl-235b-a22b-thinking",
				"z-ai/glm-5.1",
			]),
		);
	});

	it("registers the default OpenAI-compatible model", () => {
		const model = getModel("prime-inference", "openai/gpt-5.5");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("prime-inference");
		expect(model.baseUrl).toBe("https://api.pinference.ai/api/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ xhigh: "xhigh" });
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(0);
		expect(model.maxTokens).toBe(0);
		expect(model.cost).toEqual({
			input: 5,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});

	it("resolves PRIME_API_KEY from the environment", () => {
		process.env.PRIME_API_KEY = "test-prime-key";

		expect(findEnvKeys("prime-inference")).toEqual(["PRIME_API_KEY"]);
		expect(getEnvApiKey("prime-inference")).toBe("test-prime-key");
	});

	it("requires an explicit Prime Inference API key", () => {
		delete process.env.PRIME_API_KEY;

		expect(findEnvKeys("prime-inference")).toBeUndefined();
		expect(getEnvApiKey("prime-inference")).toBeUndefined();
	});
});
