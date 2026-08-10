import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getSupportedThinkingLevels } from "../src/models.js";

const originalVeniceApiKey = process.env.VENICE_API_KEY;

afterEach(() => {
	if (originalVeniceApiKey === undefined) {
		delete process.env.VENICE_API_KEY;
	} else {
		process.env.VENICE_API_KEY = originalVeniceApiKey;
	}
});

describe("Venice AI models", () => {
	it("registers the Venice GLM 5.2 default", () => {
		const model = getModel("venice", "zai-org-glm-5-2");

		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("venice");
		expect(model.baseUrl).toBe("https://api.venice.ai/api/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(131072);
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_completion_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("registers tool-capable vision models from the Venice catalog", () => {
		const model = getModel("venice", "gemini-3-1-pro-preview");

		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(getModels("venice").length).toBeGreaterThan(0);
	});

	it("maps each advertised reasoning effort exactly", () => {
		const model = getModel("venice", "zai-org-glm-4.7-flash");

		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("hides effort controls when Venice does not support them", () => {
		for (const modelId of [
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-opus-5",
			"deepseek-v4-flash",
			"deepseek-v4-pro",
		] as const) {
			const model = getModel("venice", modelId);

			expect(model.reasoning).toBe(true);
			expect(model.compat?.supportsReasoningEffort).toBe(false);
			expect(getSupportedThinkingLevels(model)).toEqual([]);
		}
	});

	it("resolves VENICE_API_KEY from the environment", () => {
		process.env.VENICE_API_KEY = "test-venice-key";

		expect(findEnvKeys("venice")).toEqual(["VENICE_API_KEY"]);
		expect(getEnvApiKey("venice")).toBe("test-venice-key");
	});
});
