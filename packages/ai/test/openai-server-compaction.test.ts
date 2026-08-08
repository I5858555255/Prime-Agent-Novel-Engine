import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1050000,
	maxTokens: 128000,
};

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("OpenAI server compaction replay", () => {
	it("persists an opaque compaction item from a Responses stream", async () => {
		const output = assistant("", { content: [] });
		const stream = new AssistantMessageEventStream();
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "compaction", id: "cmp_1", encrypted_content: "encrypted-summary" },
			},
			{
				type: "response.output_item.done",
				item: { type: "compaction", id: "cmp_1", encrypted_content: "encrypted-summary" },
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 10,
						output_tokens: 2,
						total_tokens: 12,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		] as ResponseStreamEvent[];

		await processResponsesStream(
			(async function* () {
				for (const event of events) yield event;
			})(),
			output,
			stream,
			model,
		);

		expect(output.openaiCompaction).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "encrypted-summary",
		});
	});

	it("drops input before the latest compaction item for the same OpenAI model", () => {
		const compacted = assistant("work after compaction", {
			openaiCompaction: {
				type: "compaction",
				id: "cmp_1",
				encrypted_content: "encrypted-summary",
			},
		});
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("old assistant output"),
				compacted,
				{ role: "user", content: "new user input", timestamp: 2 },
			],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(input.some((item) => JSON.stringify(item).includes("old user input"))).toBe(false);
		expect(input.some((item) => JSON.stringify(item).includes("old assistant output"))).toBe(false);
		expect(input).toContainEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "encrypted-summary",
		});
		expect(input.some((item) => JSON.stringify(item).includes("work after compaction"))).toBe(true);
		expect(input.some((item) => JSON.stringify(item).includes("new user input"))).toBe(true);
	});

	it("keeps full history when switching to a different model", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("work after compaction", {
					openaiCompaction: {
						type: "compaction",
						id: "cmp_1",
						encrypted_content: "encrypted-summary",
					},
				}),
			],
		};
		const nextModel = { ...model, id: "gpt-5.6-terra" };

		const input = convertResponsesMessages(nextModel, context, new Set(["openai"]));
		expect(input.some((item) => JSON.stringify(item).includes("old user input"))).toBe(true);
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});
});
