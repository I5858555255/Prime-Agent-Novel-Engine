import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { projectModelFitnessCandidate } from "../src/core/model-fitness.js";

describe("model fitness candidate projection", () => {
	it("projects only advisory model metadata", () => {
		const model = {
			id: "test/model",
			name: "Test Model",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.invalid",
			reasoning: true,
			thinkingLevelMap: { max: "max" },
			input: ["text", "image"],
			cost: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			featured: true,
			benchmarks: { intelligence: 50, coding: 70, agentic: 40 },
			headers: { Authorization: "secret" },
			compat: { supportsStore: false },
		} as Model<"openai-completions">;

		expect(projectModelFitnessCandidate(model)).toEqual({
			provider: "openrouter",
			id: "test/model",
			name: "Test Model",
			selector: "openrouter/test/model",
			reasoning: true,
			supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "max"],
			input: ["text", "image"],
			contextWindow: 200_000,
			maxTokens: 64_000,
			cost: { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 1.5 },
			featured: true,
			benchmarks: { intelligence: 50, coding: 70, agentic: 40 },
		});
	});

	it("does not mark absent featured flags or emit provider configuration", () => {
		const projected = projectModelFitnessCandidate({
			id: "plain",
			name: "Plain",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		expect(projected).toMatchObject({
			selector: "anthropic/plain",
			supportedThinkingLevels: ["off"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(projected).not.toHaveProperty("featured");
		expect(projected).not.toHaveProperty("benchmarks");
		expect(projected).not.toHaveProperty("baseUrl");
		expect(projected).not.toHaveProperty("headers");
		expect(projected).not.toHaveProperty("compat");
	});
});
