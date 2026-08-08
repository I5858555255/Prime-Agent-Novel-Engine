import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import { convertResponsesMessages, processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Context, Model, OpenAICompactionCheckpoint, Usage } from "../src/types.js";
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

function checkpoint(contentIndex = 0, sourceBaseUrl = model.baseUrl, id = "cmp_1"): OpenAICompactionCheckpoint {
	return {
		item: { type: "compaction", id, encrypted_content: "encrypted-summary" },
		contentIndex,
		sourceBaseUrl,
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

		expect(output.openaiCompaction).toEqual(checkpoint());
		expect(output.contextTokens).toBeNull();
		expect(output.contextTokenScope).toEqual({
			api: model.api,
			provider: model.provider,
			model: model.id,
			baseUrl: model.baseUrl,
		});
	});

	it("drops input before the latest compaction item for the same OpenAI model", () => {
		const compacted = assistant("work after compaction", {
			openaiCompaction: checkpoint(),
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
					openaiCompaction: checkpoint(),
				}),
			],
		};
		const nextModel = { ...model, id: "gpt-5.6-terra" };

		const input = convertResponsesMessages(nextModel, context, new Set(["openai"]));
		expect(input.some((item) => JSON.stringify(item).includes("old user input"))).toBe(true);
		expect(input.some((item) => item.type === "compaction")).toBe(false);
	});
	it("replays only assistant content after the checkpoint", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("", {
					content: [
						{ type: "text", text: "before checkpoint" },
						{ type: "text", text: "after checkpoint" },
					],
					openaiCompaction: checkpoint(1),
				}),
			],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("old user input");
		expect(serialized).not.toContain("before checkpoint");
		expect(serialized).toContain("after checkpoint");
	});

	it("keeps full history when the endpoint changes", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("work after compaction", { openaiCompaction: checkpoint() }),
			],
		};
		const proxyModel = { ...model, baseUrl: "https://proxy.example/v1" };

		const input = convertResponsesMessages(proxyModel, context, new Set(["openai"]));
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
		const input = convertResponsesMessages(model, { messages: [output] }, new Set(["openai"]));
		expect(input).toContainEqual({ type: "compaction", id: "cmp_2", encrypted_content: "second" });
		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("before first");
		expect(serialized).not.toContain("between checkpoints");
		expect(serialized).toContain("after second");
	});

	it("survives a JSON persistence round trip", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old user input", timestamp: 1 },
				assistant("after checkpoint", { openaiCompaction: checkpoint() }),
			],
		};
		const restored = JSON.parse(JSON.stringify(context)) as Context;

		const input = convertResponsesMessages(model, restored, new Set(["openai"]));
		expect(input.some((item) => item.type === "compaction")).toBe(true);
		expect(JSON.stringify(input)).not.toContain("old user input");
	});

	it("selects the newest checkpoint across assistant turns", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "old input", timestamp: 1 },
				assistant("after old checkpoint", { openaiCompaction: checkpoint(0, model.baseUrl, "cmp_old") }),
				{ role: "user", content: "middle input", timestamp: 2 },
				assistant("after new checkpoint", { openaiCompaction: checkpoint(0, model.baseUrl, "cmp_new") }),
				{ role: "user", content: "latest input", timestamp: 3 },
			],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		const checkpoints = input.filter((item) => item.type === "compaction");
		expect(checkpoints).toEqual([{ type: "compaction", id: "cmp_new", encrypted_content: "encrypted-summary" }]);
		const serialized = JSON.stringify(input);
		expect(serialized).not.toContain("middle input");
		expect(serialized).toContain("after new checkpoint");
		expect(serialized).toContain("latest input");
	});

	it("records usage and length stop reason for incomplete responses", async () => {
		const output = assistant("", { content: [] });
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
	});
	it("adds context management to the official Codex request builder", async () => {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		let captured: unknown;
		const request = streamOpenAICodexResponses(
			codexModel,
			{ messages: [] },
			{
				apiKey: ["aaa", payload, "bbb"].join("."),
				serverCompactionThreshold: 255616,
				onPayload: (body) => {
					captured = body;
					throw new Error("payload captured");
				},
			},
		);
		for await (const event of request) {
			if (event.type === "error") break;
		}

		expect(captured).toMatchObject({
			context_management: [{ type: "compaction", compact_threshold: 255616 }],
		});
	});
});
