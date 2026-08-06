import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import "../src/providers/register-builtins.js";
import { getApiProvider } from "../src/api-registry.js";
import { getModels } from "../src/models.js";
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "../src/providers/devin/proto/exa/api_server_pb/api_server_pb.js";
import { GetUserJwtRequestSchema, GetUserJwtResponseSchema } from "../src/providers/devin/proto/exa/auth_pb/auth_pb.js";
import {
	ChatToolCallSchema,
	ModelUsageStatsSchema,
	StopReason,
} from "../src/providers/devin/proto/exa/codeium_common_pb/codeium_common_pb.js";
import { streamDevin } from "../src/providers/devin.js";
import type { Context, Model, ToolCall } from "../src/types.js";

const devinModel: Model<"devin-agent"> = {
	id: "swe-1-6-slow",
	name: "SWE-1.6 Slow",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const context: Context = {
	systemPrompt: "You are a coding agent.",
	messages: [{ role: "user", content: "Use the task tool", timestamp: 1 }],
};

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(5 + payload.length);
	const view = new DataView(frame.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	frame.set(payload, 5);
	return frame;
}

function authPayload(): Uint8Array {
	return toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
}

describe("Devin provider", () => {
	it("registers the devin-agent streaming API", () => {
		expect(getApiProvider("devin-agent")).toBeDefined();
	});

	it("publishes the Devin SWE model", () => {
		expect(getModels("devin")).toEqual([
			expect.objectContaining({
				id: "swe-1-6-slow",
				api: "devin-agent",
				provider: "devin",
				contextWindow: 200_000,
				maxTokens: 64_000,
			}),
		]);
	});

	it("builds an authenticated Connect request with the system prompt", async () => {
		let authRequest: Uint8Array | undefined;
		let chatRequest: Uint8Array | undefined;
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (String(input).includes("GetUserJwt")) {
				authRequest = new Uint8Array(init?.body as ArrayBuffer);
				return new Response(authPayload());
			}
			chatRequest = new Uint8Array(init?.body as ArrayBuffer);
			return new Response(new Uint8Array());
		};

		await streamDevin(devinModel, context, { apiKey: "session-token", fetch: fetchImpl }).result();

		expect(authRequest).toBeDefined();
		const auth = fromBinary(GetUserJwtRequestSchema, authRequest!);
		expect(auth.metadata?.apiKey).toBe("devin-session-token$session-token");

		expect(chatRequest).toBeDefined();
		const compressedLength = new DataView(
			chatRequest!.buffer,
			chatRequest!.byteOffset,
			chatRequest!.byteLength,
		).getUint32(1, false);
		const request = fromBinary(
			GetChatMessageRequestSchema,
			gunzipSync(chatRequest!.subarray(5, 5 + compressedLength)),
		);
		expect(request.prompt).toBe("You are a coding agent.");
		expect(request.chatMessagePrompts[0]?.prompt).toBe("Use the task tool");
	});

	it("streams tool arguments and flushes the final object", async () => {
		const responses = [
			create(GetChatMessageResponseSchema, {
				deltaToolCalls: [
					create(ChatToolCallSchema, { id: "call-1", name: "task", argumentsJson: '{"agent":"task"' }),
				],
			}),
			create(GetChatMessageResponseSchema, {
				stopReason: StopReason.FUNCTION_CALL,
				deltaToolCalls: [
					create(ChatToolCallSchema, { id: "call-1", name: "task", argumentsJson: '{"agent":"task","step":2}' }),
				],
			}),
		];
		const responseBody = new Uint8Array(
			responses.flatMap((response) => [...frameConnectMessage(toBinary(GetChatMessageResponseSchema, response))]),
		);
		const fetchImpl = async (input: string | URL | Request): Promise<Response> =>
			String(input).includes("GetUserJwt") ? new Response(authPayload()) : new Response(responseBody);

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.stopReason).toBe("toolUse");
		expect((result.content[0] as ToolCall).arguments).toEqual({ agent: "task", step: 2 });
	});

	it("parses Connect frames split across reader chunks", async () => {
		const response = create(GetChatMessageResponseSchema, {
			deltaText: "split response",
			stopReason: StopReason.STOP_PATTERN,
		});
		const framed = frameConnectMessage(toBinary(GetChatMessageResponseSchema, response));
		const responseBody = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let index = 0; index < framed.length; index++) {
					controller.enqueue(framed.subarray(index, index + 1));
				}
				controller.close();
			},
		});
		const fetchImpl = async (input: string | URL | Request): Promise<Response> =>
			String(input).includes("GetUserJwt") ? new Response(authPayload()) : new Response(responseBody);

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "split response" })]);
	});

	it("includes cache tokens in total usage", async () => {
		const response = create(GetChatMessageResponseSchema, {
			stopReason: StopReason.STOP_PATTERN,
			usage: create(ModelUsageStatsSchema, {
				inputTokens: 11n,
				outputTokens: 7n,
				cacheReadTokens: 100n,
				cacheWriteTokens: 13n,
			}),
		});
		const body = frameConnectMessage(toBinary(GetChatMessageResponseSchema, response));
		const fetchImpl = async (input: string | URL | Request): Promise<Response> =>
			String(input).includes("GetUserJwt") ? new Response(authPayload()) : new Response(body);

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.usage).toMatchObject({
			input: 11,
			output: 7,
			cacheRead: 100,
			cacheWrite: 13,
			totalTokens: 131,
		});
	});

	it("rejects oversized Connect frames and cancels the response reader", async () => {
		const header = new Uint8Array(5);
		new DataView(header.buffer).setUint32(1, 32 * 1024 * 1024, false);
		let cancelled = false;
		const responseBody = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(header);
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = async (input: string | URL | Request): Promise<Response> =>
			String(input).includes("GetUserJwt") ? new Response(authPayload()) : new Response(responseBody);

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin Connect frame length");
		expect(result.errorMessage).toContain("16777216");
		expect(cancelled).toBe(true);
	});
});
