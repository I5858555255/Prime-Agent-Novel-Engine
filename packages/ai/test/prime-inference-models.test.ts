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
	it("registers the full Prime Inference catalog", () => {
		const modelIds = getModels("prime-inference").map((model) => model.id);

		// The whole catalog is registered, not a curated subset.
		expect(modelIds.length).toBeGreaterThan(28);
		expect(modelIds).toEqual(
			expect.arrayContaining([
				"anthropic/claude-opus-4.7",
				"anthropic/claude-opus-4.8",
				"deepseek/deepseek-v4-pro",
				"minimax/minimax-m3",
				"openai/gpt-5.5",
				"prime-intellect/intellect-3",
				"qwen/qwen3-coder-next",
				"x-ai/grok-4.20",
				"z-ai/glm-5.2",
				// Previously excluded by the whitelist, now included.
				"google/gemini-2.5-pro",
				"z-ai/glm-4.6",
				"meta-llama/llama-3.3-70b-instruct",
			]),
		);
		// Raw/quantization and case-variant duplicates are dropped.
		expect(modelIds).not.toContain("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16");
		expect(modelIds).not.toContain("Qwen/Qwen3-235B-A22B-Instruct-2507");
		expect(modelIds).not.toContain("zai-org/GLM-4.7");
	});

	it("sources metadata for non-curated models from OpenRouter", () => {
		const glm46 = getModel("prime-inference", "z-ai/glm-4.6");
		expect(glm46.contextWindow).toBe(202752);
		expect(glm46.reasoning).toBe(true);
		expect(glm46.provider).toBe("prime-inference");
		expect(glm46.api).toBe("openai-completions");

		const gemini = getModel("prime-inference", "google/gemini-2.5-pro");
		expect(gemini.input).toEqual(["text", "image"]);
		expect(gemini.contextWindow).toBeGreaterThan(128000);
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
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1050000);
		expect(model.maxTokens).toBe(128000);
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

	it("marks known reasoning-capable Prime Inference model families", () => {
		const opus48 = getModel("prime-inference", "anthropic/claude-opus-4.8");
		expect(opus48.reasoning).toBe(true);
		expect(opus48.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
		expect(getSupportedThinkingLevels(opus48)).toContain("xhigh");
		expect(getSupportedThinkingLevels(opus48)).toContain("max");

		expect(getModel("prime-inference", "anthropic/claude-opus-4.7").reasoning).toBe(true);
		const deepseekV4Flash = getModel("prime-inference", "deepseek/deepseek-v4-flash");
		expect(deepseekV4Flash.reasoning).toBe(true);
		expect(deepseekV4Flash.compat).toMatchObject({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
		const glm51 = getModel("prime-inference", "z-ai/glm-5.1");
		expect(glm51.reasoning).toBe(true);
		expect(glm51.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "zai",
		});
		const glm52 = getModel("prime-inference", "z-ai/glm-5.2");
		expect(glm52.reasoning).toBe(true);
		expect(glm52.compat).toMatchObject({
			supportsReasoningEffort: false,
			thinkingFormat: "zai",
		});
		expect(getModel("prime-inference", "qwen/qwen3-coder-next").reasoning).toBe(false);
		expect(getModel("prime-inference", "x-ai/grok-4.20").reasoning).toBe(true);
		expect(getModel("prime-inference", "minimax/minimax-m3").reasoning).toBe(true);
		expect(getModel("prime-inference", "moonshotai/kimi-k2.7-code").reasoning).toBe(true);
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
