import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateRawContextTokens, prepareCompaction } from "../../../src/core/compaction/index.js";
import { convertToLlm, createCompactionOutcomeMessage } from "../../../src/core/messages.js";
import type { SessionEntry } from "../../../src/core/session-manager.js";

function failedAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "context_length_exceeded",
		timestamp: 2,
	};
}

describe("issue #900 compaction recovery", () => {
	it("keeps retry evidence durable while excluding it from model and compaction context", () => {
		const oldUser: AgentMessage = { role: "user", content: "old:" + "a".repeat(100), timestamp: 1 };
		const failed = failedAssistant("failed partial:" + "b".repeat(100));
		const outcome = createCompactionOutcomeMessage("compaction failed", {
			reason: "overflow",
			outcome: "failed",
		});
		const recentUser: AgentMessage = { role: "user", content: "recent:" + "c".repeat(100), timestamp: 4 };
		const messages = [oldUser, failed, outcome, recentUser];

		expect(convertToLlm(messages)).toEqual([oldUser, recentUser]);
		expect(estimateRawContextTokens(messages)).toBe(estimateRawContextTokens([oldUser, recentUser]));

		const entries: SessionEntry[] = [
			{ type: "message", id: "u1", parentId: null, timestamp: new Date(1).toISOString(), message: oldUser },
			{ type: "message", id: "a1", parentId: "u1", timestamp: new Date(2).toISOString(), message: failed },
			{
				type: "custom_message",
				id: "o1",
				parentId: "a1",
				timestamp: new Date(3).toISOString(),
				customType: outcome.customType,
				content: outcome.content,
				display: outcome.display,
				details: outcome.details,
			},
			{ type: "message", id: "u2", parentId: "o1", timestamp: new Date(4).toISOString(), message: recentUser },
		];
		const preparation = prepareCompaction(entries, {
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 1,
		});

		expect(preparation).toBeDefined();
		expect(preparation!.messagesToSummarize).toEqual([oldUser]);
		expect(preparation!.turnPrefixMessages).toEqual([]);
	});
});
