import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

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

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("OpenAI Responses incomplete events", () => {
	it("records final usage, response ID, and length stop reason", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();
		const events = [
			{
				type: "response.incomplete",
				response: {
					id: "resp_incomplete",
					status: "incomplete",
					usage: {
						input_tokens: 30,
						output_tokens: 5,
						total_tokens: 35,
						input_tokens_details: { cached_tokens: 10 },
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

		expect(output.stopReason).toBe("length");
		expect(output.responseId).toBe("resp_incomplete");
		expect(output.usage).toMatchObject({ input: 20, cacheRead: 10, output: 5, totalTokens: 35 });
	});
});
