import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
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

async function* completedWithStatus(status: string): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 1,
		response: {
			id: "resp_unknown",
			status: status as never,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

describe("OpenAI Responses unknown status", () => {
	it("maps an unknown response status to error and preserves the raw status", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();

		// A status the SDK enum does not list yet. Must not crash the processor and
		// must not be reported as successful completion; the raw value is preserved.
		await processResponsesStream(completedWithStatus("quarantined"), output, stream, model);

		expect(output.stopReason).toBe("error");
		expect(output.stopReasonRaw).toBe("quarantined");
	});
});
