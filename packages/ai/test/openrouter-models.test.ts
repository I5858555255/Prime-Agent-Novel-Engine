import { describe, expect, test } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.js";
import { parseOpenRouterModels } from "../src/openrouter-models.js";

describe("parseOpenRouterModels", () => {
	const entry = (overrides: Record<string, unknown> = {}) => ({
		id: "vendor/model",
		name: "Model",
		supported_parameters: ["tools"],
		architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
		pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
		top_provider: { max_completion_tokens: 8192 },
		context_length: 32768,
		...overrides,
	});

	test("parses a normal entry with structured modalities and pricing", () => {
		const [model] = parseOpenRouterModels({ data: [entry()] });
		expect(model.id).toBe("vendor/model");
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("openrouter");
		expect(model.input).toEqual(["text"]);
		expect(model.cost.input).toBe(1);
		expect(model.cost.output).toBe(2);
		expect(Math.abs(model.cost.cacheRead - 0.1)).toBeLessThan(1e-9);
		expect(model.cost.cacheWrite).toBe(0);
		expect(model.contextWindow).toBe(32768);
		expect(model.maxTokens).toBe(8192);
		expect(model.reasoning).toBe(false);
	});

	test("detects image from structured input_modalities and legacy modality", () => {
		expect(
			parseOpenRouterModels({
				data: [entry({ architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } })],
			})[0].input,
		).toEqual(["text", "image"]);
		expect(
			parseOpenRouterModels({
				data: [entry({ architecture: { modality: "text+image->text", output_modalities: ["text"] } })],
			})[0].input,
		).toEqual(["text", "image"]);
	});

	test("skips non-tool and :batch entries", () => {
		const models = parseOpenRouterModels({
			data: [entry(), entry({ id: "no/tools", supported_parameters: [] }), entry({ id: "vendor/model:batch" })],
		});
		expect(models.map((m) => m.id)).toEqual(["vendor/model"]);
	});

	test("skips non-text-output models when output modalities present", () => {
		const models = parseOpenRouterModels({
			data: [entry({ architecture: { output_modalities: ["audio"] } })],
		});
		expect(models).toEqual([]);
	});

	test("mandatory reasoning sets off:null and maps supported efforts", () => {
		const [model] = parseOpenRouterModels({
			data: [
				entry({
					supported_parameters: ["tools", "reasoning"],
					reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium", "low", "minimal"] },
				}),
			],
		});
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.thinkingLevelMap?.low).toBe("low");
		expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(model.thinkingLevelMap?.max).toBeNull();
	});

	test("optional reasoning leaves off unpinned and hides unsupported efforts", () => {
		const [model] = parseOpenRouterModels({
			data: [
				entry({
					supported_parameters: ["tools", "reasoning"],
					reasoning: { mandatory: false, supported_efforts: ["max"] },
				}),
			],
		});
		expect(model.thinkingLevelMap?.off).toBeUndefined();
		expect(model.thinkingLevelMap?.medium).toBeNull();
		expect(model.thinkingLevelMap?.max).toBe("max");
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "max"]);
	});

	test("absent supported_efforts keeps every gateway effort selectable", () => {
		const [optional] = parseOpenRouterModels({
			data: [entry({ supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: false } })],
		});
		expect(optional.thinkingLevelMap).toBeUndefined();
		expect(getSupportedThinkingLevels(optional)).toEqual(["off", "minimal", "low", "medium", "high"]);

		const [mandatory] = parseOpenRouterModels({
			data: [entry({ supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: true } })],
		});
		expect(mandatory.thinkingLevelMap).toEqual({ off: null });
		expect(getSupportedThinkingLevels(mandatory)).toEqual(["minimal", "low", "medium", "high"]);
	});

	test("a reasoning object without the reasoning parameter does not enable reasoning", () => {
		const [model] = parseOpenRouterModels({
			data: [
				entry({ supported_parameters: ["tools"], reasoning: { mandatory: true, supported_efforts: ["high"] } }),
			],
		});
		expect(model.reasoning).toBe(false);
		expect(model.thinkingLevelMap).toBeUndefined();
	});

	test("legacy output-only image modality is not treated as vision input", () => {
		const [model] = parseOpenRouterModels({ data: [entry({ architecture: { modality: "text->text+image" } })] });
		expect(model.input).toEqual(["text"]);
	});

	test("tolerates null, invalid, negative and NaN pricing", () => {
		const [model] = parseOpenRouterModels({
			data: [
				entry({
					pricing: { prompt: null, completion: "NaN", input_cache_read: "-5", input_cache_write: "not-a-number" },
				}),
			],
		});
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("clamps maxTokens to context window and falls back on null limits", () => {
		const [model] = parseOpenRouterModels({
			data: [
				entry({
					context_length: 10000,
					top_provider: { max_completion_tokens: 999999 },
				}),
			],
		});
		expect(model.maxTokens).toBe(10000);
		const [fallback] = parseOpenRouterModels({
			data: [entry({ context_length: null, top_provider: { max_completion_tokens: null } })],
		});
		expect(fallback.contextWindow).toBe(4096);
		expect(fallback.maxTokens).toBe(4096);
	});

	test("applies deepseek compat correction", () => {
		const [model] = parseOpenRouterModels({ data: [entry({ id: "deepseek/deepseek-v4-pro" })] });
		expect(model.compat).toEqual({ requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" });
	});

	test("throws on a malformed top-level payload but skips malformed entries", () => {
		expect(() => parseOpenRouterModels({})).toThrow();
		expect(() => parseOpenRouterModels([1, 2])).toThrow();
		const models = parseOpenRouterModels({ data: [{}, 1, "x", entry({ id: 123 })] });
		expect(models.length).toBe(0);
	});
});
