import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";

describe("Impossibl models", () => {
	it("registers Claude Opus 4.8 via the OpenAI-compatible Completions API", () => {
		const model = getModel("impossibl", "anthropic/claude-opus-4-8");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("impossibl");
		expect(model.baseUrl).toBe("https://api.impossibl.com/v1");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost).toEqual({
			input: 5,
			output: 25,
			cacheRead: 0.5,
			cacheWrite: 6.25,
		});
	});

	it("applies the shared compat settings", () => {
		const model = getModel("impossibl", "anthropic/claude-opus-4-8");

		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: true,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			cacheControlFormat: "anthropic",
			supportsLongCacheRetention: false,
		});
	});

	it("derives thinking levels from the models.dev effort declaration", () => {
		// claude-opus-4-8 declares toggle + effort ["low","medium","high","xhigh","max"]
		const model = getModel("impossibl", "anthropic/claude-opus-4-8");

		expect(model.thinkingLevelMap).toEqual({ minimal: null, xhigh: "xhigh", max: "max" });
	});

	it("maps a declared none effort onto the off level", () => {
		// gpt-5.4 declares effort ["none","low","medium","high","xhigh"]
		const model = getModel("impossibl", "openai/gpt-5.4");

		expect(model.thinkingLevelMap).toEqual({ off: "none", minimal: null, xhigh: "xhigh" });
	});

	it("keeps the default ladder for budget_tokens routes", () => {
		// claude-haiku-4-5 declares toggle + budget_tokens; the gateway maps effort onto a budget
		const model = getModel("impossibl", "anthropic/claude-haiku-4-5");

		expect(model.thinkingLevelMap).toBeUndefined();
	});

	it("marks routes with an empty reasoning_options declaration as uncontrollable", () => {
		// deepseek-v4-pro reasons but declares no client-controllable options
		const model = getModel("impossibl", "deepseek/deepseek-v4-pro");

		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: null });
	});

	it("registers non-reasoning models without a thinking level map", () => {
		const model = getModel("impossibl", "openai/gpt-4.1");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.reasoning).toBe(false);
		expect(model.thinkingLevelMap).toBeUndefined();
	});
});
