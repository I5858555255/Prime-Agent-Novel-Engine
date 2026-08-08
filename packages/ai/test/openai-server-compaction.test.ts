import type { ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import {
	convertResponsesMessages,
	processResponsesStream,
	supportsOpenAIServerCompaction,
	usesOpenAICompactionCheckpoint,
} from "../src/providers/openai-responses-shared.js";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	OpenAICompactionCheckpoint,
	Usage,
} from "../src/types.js";
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

const codexModel: Model<"openai-codex-responses"> = {
	...model,
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	contextWindow: 272000,
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

function checkpoint(sourceBaseUrl = model.baseUrl, id = "cmp_1"): OpenAICompactionCheckpoint {
	return {
		item: { type: "compaction", id, encrypted_content: "encrypted-summary" },
		sourceBaseUrl,
	};
}

/** Context that ends in a checkpointed turn, so any replay drops "old user input". */
function checkpointedContext(overrides: Partial<AssistantMessage> = {}): Context {
	return {
		messages: [
			{ role: "user", content: "old user input", timestamp: 1 },
			assistant("work after compaction", { openaiCompaction: checkpoint(), ...overrides }),
		],
	};
}

/** The `compact_threshold` a session with server compaction on sends. */
const THRESHOLD = 200000;

/**
 * Build the request input the way a provider does. The threshold is part of the request:
 * pass `undefined` for a caller that asks the server for no compaction at all.
 */
function convert<TApi extends Api>(
	requestModel: Model<TApi>,
	context: Context,
	serverCompactionThreshold: number | undefined = THRESHOLD,
): ResponseInput {
	return convertResponsesMessages(requestModel, context, new Set(["openai"]), { serverCompactionThreshold });
}

/** The model plus the threshold its request carries, which is what the replay rule reads. */
function request<TApi extends Api>(
	requestModel: Model<TApi>,
	serverCompactionThreshold: number | undefined = THRESHOLD,
) {
	return { ...requestModel, serverCompactionThreshold };
}

function callIdsByType(input: ResponseInput, type: string): (string | undefined)[] {
	const items = JSON.parse(JSON.stringify(input)) as { type?: string; call_id?: string }[];
	return items.filter((item) => item.type === type).map((item) => item.call_id);
}

async function runStream(events: ResponseStreamEvent[], streamModel: Model<"openai-responses">) {
	const output = assistant("", { content: [] });
	await processResponsesStream(
		(async function* () {
			for (const event of events) yield event;
		})(),
		output,
		new AssistantMessageEventStream(),
		streamModel,
	);
	return output;
}

function compactionEvents(id: string): ResponseStreamEvent[] {
	return [
		{
			type: "response.output_item.added",
			item: { type: "compaction", id, encrypted_content: "encrypted-summary" },
		},
		{
			type: "response.output_item.done",
			item: { type: "compaction", id, encrypted_content: "encrypted-summary" },
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
}

describe("OpenAI Responses automatic server-side compaction", () => {
	it("persists an opaque compaction item from a Responses stream", async () => {
		const output = await runStream(compactionEvents("cmp_1"), { ...model, baseUrl: `${model.baseUrl}/` });

		expect(output.openaiCompaction).toEqual(checkpoint());
	});

	it("ignores a compaction item from an endpoint that never sends context management", async () => {
		const output = await runStream(compactionEvents("cmp_1"), { ...model, baseUrl: "https://proxy.example/v1" });

		expect(output.openaiCompaction).toBeUndefined();
	});

	it("drops input before the latest compaction item for the same OpenAI model", () => {
		const context: Context = {
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("old assistant output"),
				assistant("work after compaction", { openaiCompaction: checkpoint() }),
				{ role: "user", content: "new user input", timestamp: 2 },
			],
		};

		const input = convert(model, context);
		expect(input.some((item) => JSON.stringify(item).includes("old user input"))).toBe(false);
		expect(input.some((item) => JSON.stringify(item).includes("old assistant output"))).toBe(false);
		expect(input[0]).toEqual({
			type: "compaction",
			id: "cmp_1",
			encrypted_content: "encrypted-summary",
		});
		expect(input[1]).toEqual({ role: "developer", content: "system" });
		expect(JSON.stringify(input[2])).toContain("work after compaction");
		expect(input.some((item) => JSON.stringify(item).includes("new user input"))).toBe(true);
	});

	it("replays the checkpoint turn whole, including blocks the checkpoint already covers", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("", {
					content: [
						{ type: "text", text: "before checkpoint" },
						{ type: "text", text: "after checkpoint" },
					],
					openaiCompaction: checkpoint(),
				}),
			],
		};

		const input = convert(model, context);
		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("old user input");
		expect(serialized).toContain("before checkpoint");
		expect(serialized).toContain("after checkpoint");
	});

	it("keeps every tool call paired with its result across a checkpoint", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("", {
					content: [
						{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.txt" } },
						{ type: "text", text: "after tool call" },
					],
					openaiCompaction: checkpoint(),
				}),
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const input = convert(model, context);
		expect(callIdsByType(input, "function_call")).toEqual(["call_1"]);
		expect(callIdsByType(input, "function_call_output")).toEqual(["call_1"]);
	});

	it("keeps full history when switching to a different model", () => {
		const input = convert({ ...model, id: "gpt-5.6-terra" }, checkpointedContext());
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});

	it("keeps full history when only the provider differs", () => {
		const otherProvider = {
			...model,
			provider: "azure-openai-responses",
			compat: { supportsServerCompaction: true },
		};

		const input = convert(otherProvider, checkpointedContext());
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});

	it("keeps full history when only the api differs", () => {
		const otherApi: Model<"openai-codex-responses"> = {
			...model,
			api: "openai-codex-responses",
			compat: { supportsServerCompaction: true },
		};

		const input = convert(otherApi, checkpointedContext());
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});

	it("keeps full history when the endpoint changes", () => {
		const proxyModel = { ...model, baseUrl: "https://proxy.example/v1" };

		const input = convert(proxyModel, checkpointedContext());
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});

	it("keeps full history on another endpoint that takes context management", () => {
		// A checkpoint is opaque to every server but the one that wrote it. Here provider,
		// api, model id and the support rule all say yes, so the endpoint the checkpoint came
		// from is the only thing left to compare.
		const otherEndpoint = {
			...model,
			baseUrl: "https://proxy.example/v1",
			compat: { supportsServerCompaction: true },
		};

		expect(usesOpenAICompactionCheckpoint(request(otherEndpoint), checkpointedContext())).toBe(false);
		const input = convert(otherEndpoint, checkpointedContext());
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});

	it("matches a checkpoint through a trailing slash on the endpoint", () => {
		const slashModel = { ...model, baseUrl: `${model.baseUrl}/` };

		const input = convert(slashModel, checkpointedContext());
		expect(JSON.stringify(input)).not.toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(true);
	});

	it("stops replaying a checkpoint when the endpoint opts out of server compaction", () => {
		const optedOut = { ...model, compat: { supportsServerCompaction: false } };

		const input = convert(optedOut, checkpointedContext());
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});

	it("keeps full history when the request carries no compaction threshold", async () => {
		// A caller with compaction turned off sends no `context_management`, so it asks the
		// server to compact nothing. Handing it a checkpoint anyway would drop the history
		// ahead of that turn with no threshold running on either side.
		expect(
			usesOpenAICompactionCheckpoint({ ...model, serverCompactionThreshold: undefined }, checkpointedContext()),
		).toBe(false);

		// No options at all is what a caller that never sets the field passes.
		const input = convertResponsesMessages(model, checkpointedContext(), new Set(["openai"]));
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);

		// The request the provider actually builds says the same thing.
		let captured: { input?: unknown; context_management?: unknown } | undefined;
		const stream = streamOpenAIResponses(model, checkpointedContext(), {
			apiKey: "test-key",
			onPayload: (payload) => {
				captured = payload as { input?: unknown; context_management?: unknown };
				throw new Error("payload captured");
			},
		});
		for await (const event of stream) {
			if (event.type === "error") break;
		}
		expect(captured).not.toHaveProperty("context_management");
		expect(JSON.stringify(captured?.input)).toContain("old user input");
	});

	it("ignores a checkpoint left on a turn the request never replays", () => {
		// The stream failed after the server emitted the compaction item, so the turn
		// carrying it is dropped from the request. The converter and the pre-set that
		// stamps contextTokenBaseUrl have to agree that nothing is replayed.
		const errored = checkpointedContext({ stopReason: "error" });

		expect(usesOpenAICompactionCheckpoint(request(model), checkpointedContext())).toBe(true);
		expect(usesOpenAICompactionCheckpoint(request(model), errored)).toBe(false);

		const input = convert(model, errored);
		expect(JSON.stringify(input)).toContain("old user input");
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});

	it("uses the last of multiple checkpoints in one response", async () => {
		const output = assistant("", { content: [] });
		const stream = new AssistantMessageEventStream();
		async function* events(): AsyncGenerator<ResponseStreamEvent> {
			output.content.push({ type: "text", text: "before first" });
			yield {
				type: "response.output_item.done",
				item: { type: "compaction", id: "cmp_1", encrypted_content: "first" },
			} as ResponseStreamEvent;
			output.content.push({ type: "text", text: "between checkpoints" });
			yield {
				type: "response.output_item.done",
				item: { type: "compaction", id: "cmp_2", encrypted_content: "second" },
			} as ResponseStreamEvent;
			output.content.push({ type: "text", text: "after second" });
		}

		await processResponsesStream(events(), output, stream, model);
		const input = convert(model, { messages: [output] });
		expect(input.filter((item) => item.type === "compaction")).toEqual([
			{ type: "compaction", id: "cmp_2", encrypted_content: "second" },
		]);
		// The turn is replayed whole, so every block goes out again — including the two the
		// newest checkpoint already covers.
		const serialized = JSON.stringify(input);
		expect(serialized).toContain("before first");
		expect(serialized).toContain("between checkpoints");
		expect(serialized).toContain("after second");
	});

	it("survives a JSON persistence round trip", () => {
		const restored = JSON.parse(JSON.stringify(checkpointedContext())) as Context;

		const input = convert(model, restored);
		expect(input.some((item) => item.type === "compaction")).toBe(true);
		expect(JSON.stringify(input)).not.toContain("old user input");
	});

	it("selects the newest checkpoint across assistant turns", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old input", timestamp: 1 },
				assistant("after old checkpoint", { openaiCompaction: checkpoint(model.baseUrl, "cmp_old") }),
				{ role: "user", content: "middle input", timestamp: 2 },
				assistant("after new checkpoint", { openaiCompaction: checkpoint(model.baseUrl, "cmp_new") }),
				{ role: "user", content: "latest input", timestamp: 3 },
			],
		};

		const input = convert(model, context);
		const checkpoints = input.filter((item) => item.type === "compaction");
		expect(checkpoints).toEqual([{ type: "compaction", id: "cmp_new", encrypted_content: "encrypted-summary" }]);
		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("middle input");
		expect(serialized).toContain("after new checkpoint");
		expect(serialized).toContain("latest input");
	});

	it("records the endpoint whose checkpoint shortened the request", async () => {
		async function captureOutput(
			requestModel: Model<"openai-responses">,
			messages: Message[],
			serverCompactionThreshold?: number,
		): Promise<AssistantMessage> {
			const stream = streamOpenAIResponses(
				requestModel,
				{ messages },
				{
					apiKey: "test-key",
					serverCompactionThreshold,
					onPayload: () => {
						throw new Error("payload captured");
					},
				},
			);
			for await (const event of stream) {
				if (event.type === "error") return event.error;
			}
			throw new Error("stream did not fail");
		}

		const slashModel = { ...model, baseUrl: `${model.baseUrl}/` };
		const replayed = await captureOutput(slashModel, checkpointedContext().messages, THRESHOLD);
		expect(replayed.contextTokenBaseUrl).toBe(model.baseUrl);

		const plain = await captureOutput(model, [assistant("no checkpoint here")], THRESHOLD);
		expect(plain.contextTokenBaseUrl).toBeUndefined();

		// A request carrying no threshold replays nothing, so its usage sizes the whole
		// history and the stamp must stay off.
		const noThreshold = await captureOutput(model, checkpointedContext().messages);
		expect(noThreshold.contextTokenBaseUrl).toBeUndefined();
	});

	it("adds context management only for supported endpoints", async () => {
		async function capturePayload(requestModel: Model<"openai-responses">): Promise<unknown> {
			let captured: unknown;
			const request = streamOpenAIResponses(
				requestModel,
				{ messages: [] },
				{
					apiKey: "test-key",
					serverCompactionThreshold: 200000,
					onPayload: (payload) => {
						captured = payload;
						throw new Error("payload captured");
					},
				},
			);
			for await (const event of request) {
				if (event.type === "error") break;
			}
			return captured;
		}

		await expect(capturePayload(model)).resolves.toMatchObject({
			context_management: [{ type: "compaction", compact_threshold: 200000 }],
		});
		await expect(capturePayload({ ...model, id: "future-responses-model" })).resolves.toHaveProperty(
			"context_management",
		);
		await expect(capturePayload({ ...model, baseUrl: "https://proxy.example/v1" })).resolves.not.toHaveProperty(
			"context_management",
		);
		await expect(
			capturePayload({
				...model,
				baseUrl: "https://proxy.example/v1",
				compat: { supportsServerCompaction: true },
			}),
		).resolves.toHaveProperty("context_management");
		await expect(
			capturePayload({ ...model, compat: { supportsServerCompaction: false } }),
		).resolves.not.toHaveProperty("context_management");
		expect(
			supportsOpenAIServerCompaction({
				...model,
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
			}),
		).toBe(false);
	});

	it("adds context management to the official Codex request builder", async () => {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		let captured: unknown;
		const request = streamOpenAICodexResponses(
			codexModel,
			{
				systemPrompt: "fresh instructions",
				messages: [
					assistant("continued after checkpoint", {
						api: codexModel.api,
						provider: codexModel.provider,
						model: codexModel.id,
						openaiCompaction: checkpoint(codexModel.baseUrl),
					}),
				],
			},
			{
				apiKey: ["aaa", payload, "bbb"].join("."),
				serverCompactionThreshold: 255616,
				onPayload: (body) => {
					captured = body;
					throw new Error("payload captured");
				},
			},
		);
		let output: AssistantMessage | undefined;
		for await (const event of request) {
			if (event.type === "error") {
				output = event.error;
				break;
			}
		}

		expect(output?.contextTokenBaseUrl).toBe(codexModel.baseUrl);
		expect(captured).toMatchObject({
			instructions: "fresh instructions",
			input: [
				{ type: "compaction", id: "cmp_1", encrypted_content: "encrypted-summary" },
				expect.objectContaining({ type: "message", role: "assistant" }),
			],
			context_management: [{ type: "compaction", compact_threshold: 255616 }],
		});
	});
});
