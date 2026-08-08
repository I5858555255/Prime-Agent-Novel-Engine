import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function createOutput(model: Model<"openai-responses">): AssistantMessage {
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

function createModel(): Model<"openai-responses"> {
	return {
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
}

function messageAddedEvent(): ResponseStreamEvent {
	return {
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	} as unknown as ResponseStreamEvent;
}

function messageDoneEvent(content: Array<Record<string, unknown>>): ResponseStreamEvent {
	return {
		type: "response.output_item.done",
		item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content },
	} as unknown as ResponseStreamEvent;
}

describe("openai responses deltas without content_part.added", () => {
	it("appends output_text.delta when no content_part.added preceded it", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield messageAddedEvent();
			yield { type: "response.output_text.delta", delta: "Hello" } as ResponseStreamEvent;
			yield { type: "response.output_text.delta", delta: " world" } as ResponseStreamEvent;
			yield messageDoneEvent([{ type: "output_text", text: "Hello world" }]);
		}

		await processResponsesStream(events(), output, stream, model);

		const emitted = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const deltas = emitted.filter((event) => event.type === "text_delta").map((event) => event.delta);
		expect(deltas).toEqual(["Hello", " world"]);

		expect(output.content).toHaveLength(1);
		expect(output.content[0]?.type).toBe("text");
		if (output.content[0]?.type === "text") {
			expect(output.content[0].text).toBe("Hello world");
		}
	});

	it("appends refusal.delta when no content_part.added preceded it", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		async function* events(): AsyncIterable<ResponseStreamEvent> {
			yield messageAddedEvent();
			yield { type: "response.refusal.delta", delta: "I cannot" } as ResponseStreamEvent;
			yield messageDoneEvent([{ type: "refusal", refusal: "I cannot" }]);
		}

		await processResponsesStream(events(), output, stream, model);

		const emitted = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const deltas = emitted.filter((event) => event.type === "text_delta").map((event) => event.delta);
		expect(deltas).toEqual(["I cannot"]);

		expect(output.content).toHaveLength(1);
		expect(output.content[0]?.type).toBe("text");
		if (output.content[0]?.type === "text") {
			expect(output.content[0].text).toBe("I cannot");
		}
	});
});
