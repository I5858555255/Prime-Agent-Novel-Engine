import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "../src/types.js";

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function makeAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function makeToolResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("Orphaned tool results from aborted or errored assistant turns", () => {
	it("drops tool results whose parent tool call was aborted", () => {
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			makeAssistantMessage(
				[{ type: "toolCall", id: "call_aborted", name: "bash", arguments: { command: "ls" } }],
				"aborted",
			),
			makeToolResult("call_aborted", "bash"),
			{ role: "user", content: "try again", timestamp: Date.now() },
		];

		const result = transformMessages(messages, makeModel());

		expect(result.some((m) => m.role === "assistant")).toBe(false);
		expect(result.some((m) => m.role === "toolResult")).toBe(false);
		expect(result.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("drops tool results whose parent tool call errored", () => {
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			makeAssistantMessage(
				[{ type: "toolCall", id: "call_errored", name: "bash", arguments: { command: "ls" } }],
				"error",
			),
			makeToolResult("call_errored", "bash"),
		];

		const result = transformMessages(messages, makeModel());

		expect(result.map((m) => m.role)).toEqual(["user"]);
	});

	it("keeps tool results belonging to a surviving tool call", () => {
		const messages: Message[] = [
			{ role: "user", content: "run two commands", timestamp: Date.now() },
			makeAssistantMessage(
				[{ type: "toolCall", id: "call_aborted", name: "bash", arguments: { command: "ls" } }],
				"aborted",
			),
			makeToolResult("call_aborted", "bash"),
			makeAssistantMessage(
				[{ type: "toolCall", id: "call_healthy", name: "read", arguments: { path: "README.md" } }],
				"toolUse",
			),
			makeToolResult("call_healthy", "read"),
			{ role: "user", content: "thanks", timestamp: Date.now() },
		];

		const result = transformMessages(messages, makeModel());
		const toolResults = result.filter((m) => m.role === "toolResult") as ToolResultMessage[];

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("call_healthy");
		expect(result.some((m) => m.role === "assistant")).toBe(true);
	});
});
