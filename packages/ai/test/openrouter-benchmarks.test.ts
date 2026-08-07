import { describe, expect, it } from "vitest";
import {
	benchmarkTokenKey,
	buildOpenRouterBenchmarkIndex,
	matchOpenRouterBenchmarks,
	readOpenRouterBenchmarks,
} from "../scripts/openrouter-benchmarks.js";

const catalog = [
	{
		id: "anthropic/claude-sonnet-4.5",
		canonical_slug: "anthropic/claude-4.5-sonnet-20250929",
		benchmarks: { artificial_analysis: { intelligence_index: 36.4, coding_index: 52.1, agentic_index: 24.6 } },
	},
	{
		id: "openai/gpt-5.6-terra",
		canonical_slug: "openai/gpt-5.6-terra",
		benchmarks: { artificial_analysis: { intelligence_index: 54, coding_index: 76.7, agentic_index: 47.4 } },
	},
	{ id: "unbenchmarked/model", benchmarks: { design_arena: [] } },
];

describe("openrouter benchmark cross-reference", () => {
	it("reads the embedded Artificial Analysis indices", () => {
		expect(readOpenRouterBenchmarks(catalog[0])).toEqual({ intelligence: 36.4, coding: 52.1, agentic: 24.6 });
		expect(readOpenRouterBenchmarks(catalog[2])).toBeUndefined();
		expect(readOpenRouterBenchmarks({})).toBeUndefined();
	});

	it("matches OpenRouter provider ids exactly", () => {
		const index = buildOpenRouterBenchmarkIndex(catalog);
		expect(matchOpenRouterBenchmarks(index, { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" })).toEqual({
			intelligence: 36.4,
			coding: 52.1,
			agentic: 24.6,
		});
	});

	it("matches first-party ids with different punctuation and word order", () => {
		const index = buildOpenRouterBenchmarkIndex(catalog);
		expect(matchOpenRouterBenchmarks(index, { provider: "anthropic", id: "claude-sonnet-4-5" })).toEqual({
			intelligence: 36.4,
			coding: 52.1,
			agentic: 24.6,
		});
		expect(matchOpenRouterBenchmarks(index, { provider: "openai", id: "gpt-5.6-terra" })?.coding).toBe(76.7);
	});

	it("normalizes token keys by dropping dates and versions", () => {
		expect(benchmarkTokenKey("anthropic/claude-4.5-sonnet-20250929")).toBe(benchmarkTokenKey("claude-sonnet-4-5"));
		expect(benchmarkTokenKey("us.anthropic.claude-sonnet-4-5-v1:0")).toContain("claude");
	});

	it("returns undefined for unmatched models instead of guessing", () => {
		const index = buildOpenRouterBenchmarkIndex(catalog);
		expect(matchOpenRouterBenchmarks(index, { provider: "mistral", id: "mistral-large-3" })).toBeUndefined();
	});

	it("drops ambiguous token keys", () => {
		const ambiguous = buildOpenRouterBenchmarkIndex([
			{ id: "a/foo-bar", benchmarks: { artificial_analysis: { coding_index: 10 } } },
			{ id: "b/bar-foo", benchmarks: { artificial_analysis: { coding_index: 90 } } },
		]);
		expect(matchOpenRouterBenchmarks(ambiguous, { provider: "other", id: "foo-bar" })).toBeUndefined();
		expect(matchOpenRouterBenchmarks(ambiguous, { provider: "openrouter", id: "a/foo-bar" })?.coding).toBe(10);
	});
});
