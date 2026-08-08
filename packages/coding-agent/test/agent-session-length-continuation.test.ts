import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { shouldAutoContinueTruncatedResponse } from "../src/core/agent-session.js";

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial answer" }],
		api: "openai",
		provider: "openai",
		model: "test-model",
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

describe("shouldAutoContinueTruncatedResponse", () => {
	it("auto-continues a response cut off by the output-token limit", () => {
		const msg = assistant({ stopReason: "length", content: [{ type: "text", text: "and then..." }] });
		expect(shouldAutoContinueTruncatedResponse(msg, 0)).toBe(true);
	});

	it("does not continue when the response completed normally", () => {
		expect(shouldAutoContinueTruncatedResponse(assistant({ stopReason: "stop" }), 0)).toBe(false);
	});

	it("does not continue a length stop whose only content is tool calls", () => {
		const msg = assistant({
			stopReason: "length",
			content: [{ type: "toolCall", id: "c1", name: "ipython", arguments: {} }],
		});
		expect(shouldAutoContinueTruncatedResponse(msg, 0)).toBe(false);
	});

	it("does not continue a length stop with no output (context-overflow case)", () => {
		expect(shouldAutoContinueTruncatedResponse(assistant({ stopReason: "length", content: [] }), 0)).toBe(false);
	});

	it("respects the per-run continuation budget", () => {
		const msg = assistant({ stopReason: "length", content: [{ type: "text", text: "more..." }] });
		expect(shouldAutoContinueTruncatedResponse(msg, 2, 3)).toBe(true);
		expect(shouldAutoContinueTruncatedResponse(msg, 3, 3)).toBe(false);
	});

	it("does not continue on other stop reasons", () => {
		const toolUse = assistant({
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "c1", name: "ipython", arguments: {} }],
		});
		expect(shouldAutoContinueTruncatedResponse(toolUse, 0)).toBe(false);
		expect(shouldAutoContinueTruncatedResponse(assistant({ stopReason: "aborted" }), 0)).toBe(false);
		expect(shouldAutoContinueTruncatedResponse(assistant({ stopReason: "error" }), 0)).toBe(false);
	});
});
