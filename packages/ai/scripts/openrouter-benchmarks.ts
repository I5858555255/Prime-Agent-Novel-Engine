/**
 * Cross-reference helper for catalog generation: extracts the benchmark indices
 * OpenRouter embeds in its public model catalog (Artificial Analysis scores)
 * and matches them onto models from any provider, so `models.generated.ts` can
 * carry them without a runtime network call.
 *
 * Matching is conservative: exact id first, then a normalized token-multiset
 * key so first-party ids like "claude-sonnet-4-5" match OpenRouter's
 * "anthropic/claude-4.5-sonnet". Ambiguous keys are dropped rather than
 * guessing. Unmatched models simply carry no benchmark metadata.
 */

import type { ModelBenchmarks } from "../src/types.js";

export type OpenRouterBenchmarkIndex = Map<string, ModelBenchmarks | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toScore(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
		return undefined;
	}
	return value;
}

/** Extract the benchmark block from one raw OpenRouter catalog entry, if present. */
export function readOpenRouterBenchmarks(entry: unknown): ModelBenchmarks | undefined {
	if (!isRecord(entry) || !isRecord(entry.benchmarks)) return undefined;
	const aa = entry.benchmarks.artificial_analysis;
	if (!isRecord(aa)) return undefined;
	const benchmarks: ModelBenchmarks = {};
	const intelligence = toScore(aa.intelligence_index);
	const coding = toScore(aa.coding_index);
	const agentic = toScore(aa.agentic_index);
	if (intelligence !== undefined) benchmarks.intelligence = intelligence;
	if (coding !== undefined) benchmarks.coding = coding;
	if (agentic !== undefined) benchmarks.agentic = agentic;
	return Object.keys(benchmarks).length > 0 ? benchmarks : undefined;
}

/**
 * Normalize a model id to a token-multiset key. Splits on non-alphanumerics,
 * drops date (YYYYMMDD) and version (vN) tokens, and sorts, so word-order and
 * punctuation differences across catalogs collapse ("claude-sonnet-4-5" ==
 * "claude-4.5-sonnet-20250929").
 */
export function benchmarkTokenKey(modelId: string): string {
	const suffix = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
	const tokens = suffix
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0 && !/^\d{8}$/.test(token) && !/^v\d+$/.test(token));
	tokens.sort();
	return tokens.join(".");
}

/**
 * Build a lookup from an OpenRouter catalog (the `data` array). Exact lowercase
 * ids and canonical slugs are indexed directly; token keys are indexed only
 * when a single catalog record owns the key.
 */
export function buildOpenRouterBenchmarkIndex(catalog: unknown[]): OpenRouterBenchmarkIndex {
	const index: OpenRouterBenchmarkIndex = new Map();
	const byTokenKey = new Map<string, ModelBenchmarks | null>();

	for (const entry of catalog) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const benchmarks = readOpenRouterBenchmarks(entry);
		if (!benchmarks) continue;
		const ids = [entry.id.toLowerCase()];
		if (typeof entry.canonical_slug === "string" && entry.canonical_slug) {
			ids.push(entry.canonical_slug.toLowerCase());
		}
		for (const id of ids) {
			index.set(id, benchmarks);
		}
		const tokenKey = benchmarkTokenKey(entry.id);
		if (tokenKey) {
			const existing = byTokenKey.get(tokenKey);
			// Same record repeated under id + canonical slug is fine; two distinct
			// benchmark blocks for one key is ambiguous and must not match.
			byTokenKey.set(tokenKey, existing === undefined ? benchmarks : existing === benchmarks ? benchmarks : null);
		}
	}

	for (const [key, benchmarks] of byTokenKey) {
		if (benchmarks) index.set(`token:${key}`, benchmarks);
	}
	return index;
}

/** Look up benchmarks for a model. OpenRouter ids match exactly; other providers fall back to the token key. */
export function matchOpenRouterBenchmarks(
	index: OpenRouterBenchmarkIndex,
	model: { provider: string; id: string },
): ModelBenchmarks | undefined {
	const exact = index.get(model.id.toLowerCase());
	if (exact) return exact;
	const tokenKey = benchmarkTokenKey(model.id);
	return tokenKey ? index.get(`token:${tokenKey}`) : undefined;
}
