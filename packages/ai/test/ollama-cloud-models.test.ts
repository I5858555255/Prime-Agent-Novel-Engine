import { describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels } from "../src/models.js";

describe("Ollama Cloud models", () => {
	it("registers the direct cloud catalog with OpenAI compatibility", () => {
		const models = getModels("ollama-cloud");
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.api === "openai-completions")).toBe(true);
		expect(models.every((model) => model.baseUrl === "https://ollama.com/v1")).toBe(true);
	});

	it("resolves OLLAMA_API_KEY", () => {
		const original = process.env.OLLAMA_API_KEY;
		process.env.OLLAMA_API_KEY = "test-ollama-key";
		try {
			expect(findEnvKeys("ollama-cloud")).toEqual(["OLLAMA_API_KEY"]);
			expect(getEnvApiKey("ollama-cloud")).toBe("test-ollama-key");
		} finally {
			if (original === undefined) delete process.env.OLLAMA_API_KEY;
			else process.env.OLLAMA_API_KEY = original;
		}
	});

	it("includes the default tool-capable model", () => {
		const model = getModel("ollama-cloud", "gpt-oss:120b");
		expect(model.provider).toBe("ollama-cloud");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(131072);
		expect(model.maxTokens).toBe(32768);
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});
});
