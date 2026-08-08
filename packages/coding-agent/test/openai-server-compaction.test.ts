import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateContextTokens } from "../src/core/compaction/index.js";
import { withOpenAIServerCompaction } from "../src/core/openai-server-compaction.js";

const openAIModel: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const usage: Usage = {
	input: 250000,
	output: 10000,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 260000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("withOpenAIServerCompaction", () => {
	it("adds context management at Prime's existing reserve threshold", () => {
		const payload = withOpenAIServerCompaction({ model: openAIModel.id, input: [] }, openAIModel, {
			enabled: true,
			reserveTokens: 16384,
		});

		expect(payload).toMatchObject({
			context_management: [{ type: "compaction", compact_threshold: 255616 }],
		});
	});

	it("also enables the native Codex Responses provider", () => {
		const { compat: _compat, ...baseModel } = openAIModel;
		const codexModel: Model<"openai-codex-responses"> = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		};

		const payload = withOpenAIServerCompaction({}, codexModel, { enabled: true, reserveTokens: 16384 });
		expect(payload).toMatchObject({
			context_management: [{ type: "compaction", compact_threshold: 255616 }],
		});
	});

	it("leaves other providers and disabled compaction unchanged", () => {
		const payload = { model: openAIModel.id, input: [] };
		const thirdPartyModel = { ...openAIModel, provider: "openrouter" };

		expect(withOpenAIServerCompaction(payload, thirdPartyModel, { enabled: true, reserveTokens: 16384 })).toBe(
			payload,
		);
		expect(withOpenAIServerCompaction(payload, openAIModel, { enabled: false, reserveTokens: 16384 })).toBe(payload);
	});
});

describe("server-compacted context usage", () => {
	it("estimates from the opaque compaction boundary instead of stale pre-compaction usage", () => {
		const compactedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "continued after compaction" }],
			api: openAIModel.api,
			provider: openAIModel.provider,
			model: openAIModel.id,
			openaiCompaction: {
				type: "compaction",
				id: "cmp_1",
				encrypted_content: "x".repeat(400),
			},
			usage,
			stopReason: "stop",
			timestamp: 3,
		};
		const estimate = estimateContextTokens([
			{ role: "user", content: "old input", timestamp: 1 },
			{
				...compactedAssistant,
				openaiCompaction: undefined,
				timestamp: 2,
			},
			compactedAssistant,
			{ role: "user", content: "new input", timestamp: 4 },
		]);

		expect(estimate.lastUsageIndex).toBe(2);
		expect(estimate.tokens).toBeLessThan(1000);
		expect(estimate.tokens).toBeGreaterThan(100);
	});
});
