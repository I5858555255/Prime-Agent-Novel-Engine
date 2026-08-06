import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { resetOpenRouterModelCache } from "../src/core/openrouter-model-catalog.js";

const rawEntries = [
	{
		id: "meta/muse-spark-1.2",
		name: "Meta: Muse Spark 1.2",
		supported_parameters: ["tools", "reasoning"],
		architecture: {
			modality: "text+image+file+audio+video->text",
			input_modalities: ["text", "image", "video", "file", "audio"],
			output_modalities: ["text"],
		},
		pricing: { prompt: "0.00000125", completion: "0.00000425", input_cache_read: "0.00000015" },
		top_provider: { max_completion_tokens: null },
		context_length: 1048576,
		reasoning: {
			mandatory: true,
			supported_efforts: ["xhigh", "high", "medium", "low", "minimal"],
			default_effort: "medium",
		},
	},
	{
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		supported_parameters: ["tools", "reasoning"],
		architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
		pricing: { prompt: "0.000000435", completion: "0.0000019" },
		top_provider: { max_completion_tokens: 8192 },
		context_length: 32768,
		reasoning: { mandatory: false, supported_efforts: ["xhigh", "high"] },
	},
];

const liveResponse = (): Partial<Response> => ({ ok: true, status: 200, json: async () => ({ data: rawEntries }) });

describe("ModelRegistry live OpenRouter catalog", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-openrouter-live-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOpenRouterModelCache();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => liveResponse() as Response),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetOpenRouterModelCache();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	test("adds a newly released model from the live catalog", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const snapshot = await registry.refreshModelCatalog();
		const model = snapshot.models.find((m) => m.provider === "openrouter" && m.id === "meta/muse-spark-1.2");
		expect(model).toBeDefined();
		expect(model?.thinkingLevelMap?.off).toBeNull();
		expect(model?.input).toEqual(["text", "image"]);
	});

	test("preserves virtual aliases absent from live and curated static compat", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const snapshot = await registry.refreshModelCatalog();
		expect(snapshot.models.some((m) => m.provider === "openrouter" && m.id === "auto")).toBe(true);
		const deepseek = snapshot.models.find((m) => m.provider === "openrouter" && m.id === "deepseek/deepseek-v4-pro");
		expect(deepseek?.compat).toEqual({
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		});
	});

	test("a custom same-id model still wins over the live entry", async () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					openrouter: {
						api: "openai-completions",
						apiKey: "TEST_KEY",
						models: [
							{
								id: "meta/muse-spark-1.2",
								name: "Custom Muse",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 1000,
								maxTokens: 100,
							},
						],
					},
				},
			}),
		);
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		const model = registry.find("openrouter", "meta/muse-spark-1.2");
		expect(model?.name).toBe("Custom Muse");
		expect(model?.reasoning).toBe(false);
	});

	test("second refresh retains live models", async () => {
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		await registry.refreshModelCatalog();
		await registry.refreshModelCatalog();
		expect(registry.find("openrouter", "meta/muse-spark-1.2")).toBeDefined();
	});
});
