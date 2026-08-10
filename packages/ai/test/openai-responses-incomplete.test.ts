import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { OpenAIResponsesStreamOptions } from "../src/providers/openai-responses-shared.js";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";
import { streamFailureFromStopReason } from "../src/utils/stream-failure.js";

// Priced, so the cost an incomplete turn is charged is visible.
const model: Model<"openai-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 12, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 1050000,
	maxTokens: 128000,
};

// 30 input tokens of which 10 were served from cache, plus 5 output tokens.
const responseUsage = {
	input_tokens: 30,
	output_tokens: 5,
	total_tokens: 35,
	input_tokens_details: { cached_tokens: 10 },
};

// 20 * $3/M, 5 * $12/M, 10 * $0.3/M.
const expectedCost = { input: 0.00006, output: 0.00006, cacheRead: 0.000003, total: 0.000123 };

const serviceTierMultiplier = 0.5;

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

/** Records the tier the stream resolved and halves the cost, like the flex tier does. */
function createServiceTierOptions(): {
	options: OpenAIResponsesStreamOptions;
	resolvedTiers: (string | null | undefined)[];
} {
	const resolvedTiers: (string | null | undefined)[] = [];
	return {
		resolvedTiers,
		options: {
			serviceTier: "auto",
			applyServiceTierPricing: (usage, serviceTier) => {
				resolvedTiers.push(serviceTier);
				usage.cost.input *= serviceTierMultiplier;
				usage.cost.output *= serviceTierMultiplier;
				usage.cost.cacheRead *= serviceTierMultiplier;
				usage.cost.cacheWrite *= serviceTierMultiplier;
				usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
			},
		},
	};
}

/**
 * `incompleteDetails` is passed through verbatim so a case can send the field the
 * way the API does: absent reason, `null` details, or one of the declared reasons.
 */
function incompleteEvent(options: {
	id: string;
	incompleteDetails?: { reason?: string } | null;
	serviceTier?: string;
}): ResponseStreamEvent {
	return {
		type: "response.incomplete",
		response: {
			id: options.id,
			status: "incomplete",
			incomplete_details: options.incompleteDetails ?? null,
			...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
			usage: responseUsage,
		},
	} as ResponseStreamEvent;
}

function createdEvent(id: string): ResponseStreamEvent {
	return { type: "response.created", response: { id, status: "in_progress" } } as ResponseStreamEvent;
}

async function runStream(
	events: ResponseStreamEvent[],
	options?: OpenAIResponsesStreamOptions,
): Promise<AssistantMessage> {
	const output = createOutput();
	await processResponsesStream(
		(async function* () {
			for (const event of events) yield event;
		})(),
		output,
		new AssistantMessageEventStream(),
		model,
		options,
	);
	return output;
}

describe("OpenAI Responses incomplete events", () => {
	it("charges the usage and cost of a truncated turn and stops it with reason length", async () => {
		const { options, resolvedTiers } = createServiceTierOptions();

		const output = await runStream(
			[
				createdEvent("resp_incomplete"),
				incompleteEvent({
					id: "resp_incomplete",
					incompleteDetails: { reason: "max_output_tokens" },
					serviceTier: "flex",
				}),
			],
			options,
		);

		expect(output.stopReason).toBe("length");
		expect(output.stopReasonRaw).toBeUndefined();
		expect(output.usage).toMatchObject({ input: 20, cacheRead: 10, output: 5, cacheWrite: 0, totalTokens: 35 });
		// The response's own tier wins over the requested one, and it is applied here
		// exactly as it is on response.completed.
		expect(resolvedTiers).toEqual(["flex"]);
		expect(output.usage.cost.input).toBeCloseTo(expectedCost.input * serviceTierMultiplier, 12);
		expect(output.usage.cost.output).toBeCloseTo(expectedCost.output * serviceTierMultiplier, 12);
		expect(output.usage.cost.cacheRead).toBeCloseTo(expectedCost.cacheRead * serviceTierMultiplier, 12);
		expect(output.usage.cost.total).toBeCloseTo(expectedCost.total * serviceTierMultiplier, 12);
		// response.created already set the ID on a full stream, so this is not what the
		// incomplete arm restores. It pins that the arm does not overwrite or clear it.
		expect(output.responseId).toBe("resp_incomplete");
	});

	it("takes the response ID from the incomplete event when no response.created arrived", async () => {
		const output = await runStream([
			incompleteEvent({ id: "resp_terminal_only", incompleteDetails: { reason: "max_output_tokens" } }),
		]);

		expect(output.responseId).toBe("resp_terminal_only");
		expect(output.usage.cost.total).toBeCloseTo(expectedCost.total, 12);
	});

	it("keeps the length stop reason when the response carries no incomplete_details", async () => {
		const output = await runStream([incompleteEvent({ id: "resp_no_details", incompleteDetails: null })]);

		expect(output.stopReason).toBe("length");
		expect(output.stopReasonRaw).toBeUndefined();
		expect(output.usage.totalTokens).toBe(35);
	});

	it("keeps the length stop reason when incomplete_details carries no reason", async () => {
		const output = await runStream([incompleteEvent({ id: "resp_empty_details", incompleteDetails: {} })]);

		expect(output.stopReason).toBe("length");
		expect(output.stopReasonRaw).toBeUndefined();
	});

	it("maps a content_filter incomplete response to an error stop reason", async () => {
		const output = await runStream([
			incompleteEvent({ id: "resp_filtered", incompleteDetails: { reason: "content_filter" } }),
		]);

		expect(output.stopReason).toBe("error");
		// stopReasonRaw is what the provider hands the failure classifier. The status
		// "incomplete" classifies as "unknown"; "content_filter" classifies as a block.
		expect(output.stopReasonRaw).toBe("content_filter");
		expect(streamFailureFromStopReason(output.stopReasonRaw).info.kind).toBe("safety");
		// A transport that pushes this message straight through instead of throwing still
		// has to name the block: an error stop reason with no message renders as "Unknown
		// error" and classifies as non-retryable by accident.
		expect(output.errorMessage).toBe(streamFailureFromStopReason("content_filter").message);
		expect(output.errorMessage).toContain("content_filter");
		// The request still ran, so its usage and cost are still charged.
		expect(output.usage.totalTokens).toBe(35);
		expect(output.usage.cost.total).toBeCloseTo(expectedCost.total, 12);
	});

	it("keeps the length stop reason for an incomplete turn that holds a tool call", async () => {
		const output = await runStream([
			createdEvent("resp_tool"),
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" },
			} as ResponseStreamEvent,
			{ type: "response.function_call_arguments.done", arguments: '{"path":"README.md"}' } as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "read",
					arguments: '{"path":"README.md"}',
				},
			} as ResponseStreamEvent,
			incompleteEvent({ id: "resp_tool", incompleteDetails: { reason: "max_output_tokens" } }),
		]);

		// The toolUse promotion is deliberately limited to a turn that stopped normally.
		// A turn the server cut short reports that it was cut short, not what it holds.
		expect(output.content.some((block) => block.type === "toolCall")).toBe(true);
		expect(output.stopReason).toBe("length");
	});
});
