/**
 * Deterministic coverage for Bedrock usage totals.
 *
 * Bedrock's ConverseStream metadata event may omit `totalTokens`. When it does,
 * the provider must compute the total from all four components, including cache
 * reads and cache writes. A native total, when present, stays authoritative.
 */

import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	streamEvents: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<Record<string, unknown>> {
			const events = [...bedrockMock.streamEvents];
			return Promise.resolve({
				$metadata: { httpStatusCode: 200, requestId: "mock-request-id" },
				stream: (async function* () {
					for (const event of events) {
						yield event;
					}
				})(),
			});
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context, Usage } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

async function streamUsage(usage: Record<string, number>): Promise<Usage> {
	bedrockMock.streamEvents = [
		{ messageStart: { role: "assistant" } },
		{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hi" } } },
		{ contentBlockStop: { contentBlockIndex: 0 } },
		{ messageStop: { stopReason: "end_turn" } },
		{ metadata: { usage } },
	];

	const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
	const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();

	expect(message.stopReason).toBe("stop");
	return message.usage;
}

describe("bedrock total tokens", () => {
	it("includes cache read and cache write tokens when the metadata event omits a native total", async () => {
		const usage = await streamUsage({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadInputTokens: 100,
			cacheWriteInputTokens: 40,
		});

		expect(usage.input).toBe(10);
		expect(usage.output).toBe(5);
		expect(usage.cacheRead).toBe(100);
		expect(usage.cacheWrite).toBe(40);
		expect(usage.totalTokens).toBe(155);
	});

	it("includes cache read and cache write tokens when the native total is zero", async () => {
		const usage = await streamUsage({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadInputTokens: 100,
			cacheWriteInputTokens: 40,
			totalTokens: 0,
		});

		expect(usage.totalTokens).toBe(155);
	});

	it("keeps the native total when the metadata event reports one", async () => {
		const usage = await streamUsage({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadInputTokens: 100,
			cacheWriteInputTokens: 40,
			totalTokens: 999,
		});

		expect(usage.totalTokens).toBe(999);
	});
});
