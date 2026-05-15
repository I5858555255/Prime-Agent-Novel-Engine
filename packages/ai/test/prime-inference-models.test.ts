import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";

const originalPrimeApiKey = process.env.PRIME_API_KEY;
const originalHome = process.env.HOME;
let tempHome: string | undefined;

afterEach(() => {
	if (originalPrimeApiKey === undefined) {
		delete process.env.PRIME_API_KEY;
	} else {
		process.env.PRIME_API_KEY = originalPrimeApiKey;
	}

	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}

	if (tempHome && existsSync(tempHome)) {
		rmSync(tempHome, { recursive: true });
	}
	tempHome = undefined;
});

describe("Prime Inference models", () => {
	it("registers the default OpenAI-compatible model", () => {
		const model = getModel("prime-inference", "openai/gpt-5.5");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("prime-inference");
		expect(model.baseUrl).toBe("https://api.pinference.ai/api/v1");
		expect(model.input).toEqual(["text"]);
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		});
	});

	it("resolves PRIME_API_KEY from the environment", () => {
		process.env.PRIME_API_KEY = "test-prime-key";

		expect(findEnvKeys("prime-inference")).toEqual(["PRIME_API_KEY"]);
		expect(getEnvApiKey("prime-inference")).toBe("test-prime-key");
	});

	it("falls back to the Prime CLI config file", () => {
		delete process.env.PRIME_API_KEY;
		tempHome = join(tmpdir(), `pi-test-prime-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempHome, ".prime"), { recursive: true });
		writeFileSync(join(tempHome, ".prime", "config.json"), JSON.stringify({ api_key: "test-prime-cli-key" }));
		process.env.HOME = tempHome;

		expect(findEnvKeys("prime-inference")).toBeUndefined();
		expect(getEnvApiKey("prime-inference")).toBe("test-prime-cli-key");
	});
});
