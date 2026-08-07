import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";

const originalGreenptApiKey = process.env.GREENPT_API_KEY;

afterEach(() => {
	if (originalGreenptApiKey === undefined) {
		delete process.env.GREENPT_API_KEY;
	} else {
		process.env.GREENPT_API_KEY = originalGreenptApiKey;
	}
});

describe("GreenPT models", () => {
	it.each([
		["glm-5.2", 1_000_000, 131_072],
		["kimi-k2.7-code", 262_144, 262_144],
	] as const)("registers %s as a featured OpenAI-compatible reasoning model", (modelId, contextWindow, maxTokens) => {
		const model = getModel("greenpt", modelId);

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("greenpt");
		expect(model.baseUrl).toBe("https://api.greenpt.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(contextWindow);
		expect(model.maxTokens).toBe(maxTokens);
		expect(model.featured).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ off: "none" });
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});

	it("resolves GREENPT_API_KEY from the environment", () => {
		process.env.GREENPT_API_KEY = "test-greenpt-key";

		expect(findEnvKeys("greenpt")).toEqual(["GREENPT_API_KEY"]);
		expect(getEnvApiKey("greenpt")).toBe("test-greenpt-key");
	});
});
