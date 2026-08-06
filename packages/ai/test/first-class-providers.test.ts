import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getModels, getProviders } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

interface ClientOptions {
	apiKey?: string;
	baseURL?: string;
	defaultHeaders?: Record<string, string>;
}

const mockState = vi.hoisted(() => ({
	clientOptions: [] as ClientOptions[],
	completionParams: [] as Array<Record<string, unknown>>,
	responseParams: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: ClientOptions) {
			mockState.clientOptions.push(options);
		}

		chat = {
			completions: {
				create: (params: Record<string, unknown>) => {
					mockState.completionParams.push(params);
					throw new Error("mock transport stop");
				},
			},
		};

		responses = {
			create: (params: Record<string, unknown>) => {
				mockState.responseParams.push(params);
				throw new Error("mock transport stop");
			},
		};
	}

	return { default: FakeOpenAI };
});

const originalEnvironment = {
	CLINE_API_KEY: process.env.CLINE_API_KEY,
	MODEL_API_KEY: process.env.MODEL_API_KEY,
	ALIBABA_TOKEN_PLAN_API_KEY: process.env.ALIBABA_TOKEN_PLAN_API_KEY,
	ALIBABA_TOKEN_PLAN_BASE_URL: process.env.ALIBABA_TOKEN_PLAN_BASE_URL,
};

function restoreEnvironment(name: keyof typeof originalEnvironment): void {
	const value = originalEnvironment[name];
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

beforeEach(() => {
	mockState.clientOptions.length = 0;
	mockState.completionParams.length = 0;
	mockState.responseParams.length = 0;
	delete process.env.CLINE_API_KEY;
	delete process.env.MODEL_API_KEY;
	delete process.env.ALIBABA_TOKEN_PLAN_API_KEY;
	delete process.env.ALIBABA_TOKEN_PLAN_BASE_URL;
});

afterEach(() => {
	restoreEnvironment("CLINE_API_KEY");
	restoreEnvironment("MODEL_API_KEY");
	restoreEnvironment("ALIBABA_TOKEN_PLAN_API_KEY");
	restoreEnvironment("ALIBABA_TOKEN_PLAN_BASE_URL");
});

const context = {
	systemPrompt: "Use the tool when needed.",
	messages: [{ role: "user" as const, content: "Say hello", timestamp: 1 }],
	tools: [
		{
			name: "echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
		},
	],
};

describe("first-class provider catalogs", () => {
	it("registers current ClinePass, Meta, and Alibaba Token Plan models", () => {
		expect(getProviders()).toEqual(expect.arrayContaining(["cline-pass", "meta", "alibaba-token-plan"]));

		const clineIds = getModels("cline-pass").map((model) => model.id);
		expect(clineIds).toEqual(
			expect.arrayContaining([
				"cline-pass/glm-5.2",
				"cline-pass/kimi-k3",
				"cline-pass/deepseek-v4-pro",
				"cline-pass/qwen3.7-max",
			]),
		);
		expect(clineIds.every((id) => id.startsWith("cline-pass/"))).toBe(true);

		const metaModels = getModels("meta");
		expect(metaModels.map((model) => model.id)).toEqual([
			"muse-spark-1.1",
			"muse-spark-1.2",
			"muse-spark-1.2-contributor",
		]);
		expect(metaModels.every((model) => model.api === "openai-responses")).toBe(true);
		expect(metaModels.every((model) => model.contextWindow === 1_048_576 && model.maxTokens === 131_072)).toBe(true);

		const tokenPlanIds = getModels("alibaba-token-plan").map((model) => model.id);
		expect(tokenPlanIds).toEqual(
			expect.arrayContaining([
				"qwen3.8-max",
				"qwen3.7-plus",
				"deepseek-v4-pro",
				"kimi-k2.7-code",
				"glm-5.2",
				"MiniMax-M2.5",
			]),
		);
		expect(tokenPlanIds).not.toContain("qwen3.8-max-preview");
		expect(getModels("alibaba-token-plan").every((model) => model.cost.input === 0 && model.cost.output === 0)).toBe(
			true,
		);
	});

	it("resolves each documented environment variable", () => {
		process.env.CLINE_API_KEY = "cline-test-key";
		process.env.MODEL_API_KEY = "meta-test-key";
		process.env.ALIBABA_TOKEN_PLAN_API_KEY = "sk-sp-test-key";

		expect(findEnvKeys("cline-pass")).toEqual(["CLINE_API_KEY"]);
		expect(getEnvApiKey("cline-pass")).toBe("cline-test-key");
		expect(findEnvKeys("meta")).toEqual(["MODEL_API_KEY"]);
		expect(getEnvApiKey("meta")).toBe("meta-test-key");
		expect(findEnvKeys("alibaba-token-plan")).toEqual(["ALIBABA_TOKEN_PLAN_API_KEY"]);
		expect(getEnvApiKey("alibaba-token-plan")).toBe("sk-sp-test-key");
	});
});

describe("first-class provider request routing", () => {
	it("routes full ClinePass slugs through OpenAI-compatible Chat Completions", async () => {
		const model = getModel("cline-pass", "cline-pass/qwen3.7-max");
		await streamSimple(model, context, { apiKey: "cline-test-key", reasoning: "high", maxTokens: 100 }).result();

		expect(mockState.clientOptions[0]).toMatchObject({
			apiKey: "cline-test-key",
			baseURL: "https://api.cline.bot/api/v1",
		});
		expect(mockState.completionParams[0]).toMatchObject({
			model: "cline-pass/qwen3.7-max",
			stream: true,
			max_tokens: 100,
		});
		expect(mockState.completionParams[0]).not.toHaveProperty("reasoning_effort");
	});

	it("routes Meta through Responses with encrypted reasoning replay and tools", async () => {
		const model = getModel("meta", "muse-spark-1.2");
		await streamSimple(model, context, { apiKey: "meta-test-key", reasoning: "xhigh" }).result();

		expect(mockState.clientOptions[0]).toMatchObject({
			apiKey: "meta-test-key",
			baseURL: "https://api.meta.ai/v1",
		});
		expect(mockState.responseParams[0]).toMatchObject({
			model: "muse-spark-1.2",
			stream: true,
			store: false,
			reasoning: { effort: "xhigh", summary: "auto" },
			include: ["reasoning.encrypted_content"],
		});
		expect(mockState.responseParams[0]?.tools).toHaveLength(1);
	});

	it("uses Alibaba thinking controls and honors its base URL override", async () => {
		process.env.ALIBABA_TOKEN_PLAN_BASE_URL = "https://token-plan.example.test/compatible-mode/v1/";
		const model = getModel("alibaba-token-plan", "qwen3.8-max");

		await streamSimple(model, context, {
			apiKey: "sk-sp-test-key",
			maxTokens: 100,
		}).result();
		expect(mockState.clientOptions[0]?.baseURL).toBe("https://token-plan.example.test/compatible-mode/v1");
		expect(mockState.completionParams[0]).toMatchObject({
			model: "qwen3.8-max",
			enable_thinking: false,
			max_tokens: 100,
		});

		await streamSimple(model, context, { apiKey: "sk-sp-test-key", reasoning: "high" }).result();
		expect(mockState.completionParams[1]).toMatchObject({ enable_thinking: true });
	});

	it("does not send Qwen-only thinking parameters to other Alibaba models", async () => {
		const model = getModel("alibaba-token-plan", "deepseek-v4-pro");
		await streamSimple(model, context, { apiKey: "sk-sp-test-key", reasoning: "high" }).result();

		expect(mockState.completionParams[0]).toMatchObject({ model: "deepseek-v4-pro" });
		expect(mockState.completionParams[0]).not.toHaveProperty("enable_thinking");
		expect(mockState.completionParams[0]).not.toHaveProperty("reasoning_effort");
	});

	it("returns a provider-specific missing credential error without making a request", async () => {
		const model = getModel("meta", "muse-spark-1.2");
		const result = await streamSimple(model, context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("No API key for provider: meta");
		expect(mockState.clientOptions).toHaveLength(0);
	});
});
