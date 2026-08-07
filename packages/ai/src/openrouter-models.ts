import type { KnownProvider, Model } from "./types.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Parse a single page of the OpenRouter model catalog into normalized models.
 * Skips malformed individual entries, drops the live `:batch` routes, and only
 * keeps routes that advertise tool support. Throws on a malformed top-level
 * payload or a payload with a missing `data` array.
 */
export function parseOpenRouterModels(payload: unknown): Model<"openai-completions">[] {
	if (!isObject(payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid OpenRouter model catalog payload");
	}
	const models: Model<"openai-completions">[] = [];
	for (const raw of payload.data as unknown[]) {
		const model = parseOpenRouterModel(raw);
		if (model) models.push(model);
	}
	return models;
}

function parseOpenRouterModel(raw: unknown): Model<"openai-completions"> | undefined {
	if (!isObject(raw)) return undefined;
	const id = typeof raw.id === "string" ? raw.id : undefined;
	if (!id) return undefined;
	const parameters = stringArray(raw.supported_parameters);
	if (!parameters.includes("tools") || id.endsWith(":batch")) return undefined;

	const architecture = isObject(raw.architecture) ? raw.architecture : {};
	const output = stringArray(architecture.output_modalities);
	if (output.length > 0 && !output.includes("text")) return undefined;

	const input: ("text" | "image")[] = hasImageInput(architecture) ? ["text", "image"] : ["text"];

	const pricing = isObject(raw.pricing) ? raw.pricing : {};
	const toCost = (value: unknown): number => {
		const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
		return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0;
	};

	const contextWindow = finitePositive(raw.context_length) ?? 4096;
	const topProvider = isObject(raw.top_provider) ? raw.top_provider : {};
	const model: Model<"openai-completions"> = {
		id,
		name: typeof raw.name === "string" ? raw.name : id,
		api: "openai-completions",
		provider: "openrouter" as KnownProvider,
		baseUrl: OPENROUTER_BASE_URL,
		reasoning: parameters.includes("reasoning"),
		input,
		cost: {
			input: toCost(pricing.prompt),
			output: toCost(pricing.completion),
			cacheRead: toCost(pricing.input_cache_read),
			cacheWrite: toCost(pricing.input_cache_write),
		},
		contextWindow,
		maxTokens: finitePositive(topProvider.max_completion_tokens) ?? 4096,
	};
	if (model.maxTokens > contextWindow) model.maxTokens = contextWindow;
	if (model.reasoning) {
		const thinkingLevelMap = deriveThinkingLevelMap(isObject(raw.reasoning) ? raw.reasoning : undefined);
		if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
	}
	if (id.includes("deepseek-v4")) {
		model.compat = { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" };
	}
	return model;
}

/**
 * `supported_efforts` is an allowlist; when it is absent OpenRouter accepts every
 * gateway effort, so no level is pinned. `mandatory` routes reject "none", so
 * "off" is marked unsupported.
 */
function deriveThinkingLevelMap(
	reasoning: Record<string, unknown> | undefined,
): Model<"openai-completions">["thinkingLevelMap"] | undefined {
	const map: NonNullable<Model<"openai-completions">["thinkingLevelMap"]> = {};
	if (reasoning?.mandatory === true) map.off = null;
	if (Array.isArray(reasoning?.supported_efforts)) {
		const efforts = new Set(stringArray(reasoning.supported_efforts));
		for (const level of EFFORT_LEVELS) {
			map[level] = efforts.has(level) ? level : null;
		}
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

function hasImageInput(architecture: Record<string, unknown>): boolean {
	const modalities = stringArray(architecture.input_modalities);
	if (modalities.length > 0) return modalities.includes("image");
	// Legacy combined field, e.g. "text+image->text"; only the input side counts.
	const modality = typeof architecture.modality === "string" ? architecture.modality : "";
	return modality.split("->")[0].includes("image");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finitePositive(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
