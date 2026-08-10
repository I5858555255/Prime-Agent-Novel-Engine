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

async function* createFunctionCallEvents(
	argumentsJson: string,
	deltas = ['{"path":"README.md"', ',"content":"updated"}'],
): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: "",
		},
	} as ResponseStreamEvent;
	for (const delta of deltas) {
		yield {
			type: "response.function_call_arguments.delta",
			delta,
		} as ResponseStreamEvent;
	}
	yield {
		type: "response.function_call_arguments.done",
		arguments: argumentsJson,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: argumentsJson,
		},
	} as ResponseStreamEvent;
}

async function* createInterruptedFunctionCallEvents(deltas: string[]): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		item: {
			type: "function_call",
			id: "fc_test",
			call_id: "call_test",
			name: "edit",
			arguments: "",
		},
	} as ResponseStreamEvent;
	for (const delta of deltas) {
		yield {
			type: "response.function_call_arguments.delta",
			delta,
		} as ResponseStreamEvent;
	}
	throw new Error("interrupted response stream");
}

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

describe("openai responses partialJson cleanup", () => {
	it("removes partialJson from persisted tool-call blocks at output_item.done", async () => {
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");
		const argumentsJson = '{"path":"README.md","content":"updated"}';

		await processResponsesStream(createFunctionCallEvents(argumentsJson), output, stream, model);

		expect(output.content).toHaveLength(1);
		const persistedToolCall = output.content[0];
		expect(persistedToolCall?.type).toBe("toolCall");
		if (!persistedToolCall || persistedToolCall.type !== "toolCall") {
			throw new Error("Expected toolCall block");
		}
		expect(persistedToolCall.arguments).toEqual({ path: "README.md", content: "updated" });
		expect("partialJson" in persistedToolCall).toBe(false);

		const emittedEvents = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const toolCallEnd = emittedEvents.find((event) => event.type === "toolcall_end");
		expect(toolCallEnd).toBeDefined();
		if (!toolCallEnd || toolCallEnd.type !== "toolcall_end") {
			throw new Error("Expected toolcall_end event");
		}
		expect(toolCallEnd.toolCall).toBe(persistedToolCall);
		expect("partialJson" in toolCallEnd.toolCall).toBe(false);
	});

	it("emits every raw delta and finalizes complex arguments exactly", async () => {
		const expected = {
			nested: { quote: 'say "hello"', path: "C:\\tmp", emoji: "🫠" },
			items: [1, true, null],
		};
		const argumentsJson = JSON.stringify(expected);
		const deltas = argumentsJson.split("");
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(createFunctionCallEvents(argumentsJson, deltas), output, stream, model);

		const emittedDeltas = pushSpy.mock.calls
			.map(([event]) => event as AssistantMessageEvent)
			.filter((event) => event.type === "toolcall_delta")
			.map((event) => event.delta);
		expect(emittedDeltas).toEqual(deltas);
		expect(output.content[0]).toMatchObject({ type: "toolCall", arguments: expected });
	});

	it("keeps emitted deltas and displayable partial arguments when the stream is interrupted", async () => {
		const deltas = ['{"first":"materialized"', ',"x":1}'];
		expect(deltas.map((delta) => delta.length)).toEqual([23, 7]);
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await expect(
			processResponsesStream(createInterruptedFunctionCallEvents(deltas), output, stream, model),
		).rejects.toThrow("interrupted response stream");

		const emittedEvents = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		expect(emittedEvents.filter((event) => event.type === "toolcall_delta").map((event) => event.delta)).toEqual(
			deltas,
		);
		expect(emittedEvents.some((event) => event.type === "toolcall_end")).toBe(false);
		expect(output.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { first: "materialized", x: 1 },
		});
	});
});
