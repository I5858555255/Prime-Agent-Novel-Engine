/**
 * Regression for #913: the agent loop parked for a compaction that could never run.
 *
 * Two places decide whether the local threshold still owns compaction.
 * `_thresholdCompactionNeeded`, reached from `_shouldStopAfterTurn`, PARKS the loop after
 * the turn. `_checkCompaction` runs the compaction whose completion UNPARKS it. While only
 * one of them knew the request had handed the threshold to the server, an official-endpoint
 * OpenAI model over the threshold stopped the loop and nothing restarted it, with no
 * message to the user.
 *
 * Both now read one predicate: the threshold the request actually carries. These tests pin
 * the pairing — a park always has its compaction — across the shapes that made the two
 * answers differ.
 */

import type { AgentMessage, ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type HarnessOptions } from "../harness.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1";
/** Big enough that the prompts below never reach it, and the tool result always does. */
const ROOMY_CONTEXT_WINDOW = 200_000;

type SessionThresholdInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<boolean>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_postCompactionContinuationScheduled: boolean;
};

interface ThresholdOutcome {
	/** `_shouldStopAfterTurn` stopped the loop after the turn. */
	parked: boolean;
	/** Reasons `_checkCompaction` started a compaction for. */
	compactionReasons: string[];
}

async function createOpenAIHarness(baseUrl: string, settings: NonNullable<HarnessOptions["settings"]>) {
	const harness = await createHarness({
		api: "openai-responses",
		provider: "openai",
		persistSession: true,
		settings,
		models: [{ id: "gpt-5.6-sol", contextWindow: ROOMY_CONTEXT_WINDOW }],
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "compacted by the extension",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		],
	});
	Object.assign(harness.getModel(), { baseUrl });
	return harness;
}

/**
 * Run two real turns, then hand the session a tool result far past the threshold and ask
 * both halves of the decision what they do with it.
 *
 * `contextWindow` shrinks the model after those turns, the way switching to a
 * smaller-context model does. The turns have to happen under a window that does not already
 * compact, or the compaction boundary they leave behind suppresses the threshold check.
 */
async function driveOverThreshold(harness: Harness, contextWindow = ROOMY_CONTEXT_WINDOW): Promise<ThresholdOutcome> {
	harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
	await harness.session.prompt("one");
	await harness.session.prompt("two");
	expect(harness.eventsOfType("compaction_start")).toEqual([]);
	Object.assign(harness.getModel(), { contextWindow });

	const assistantMessage = [...harness.session.messages]
		.reverse()
		.find((message): message is AssistantMessage => message.role === "assistant");
	if (!assistantMessage) throw new Error("the session produced no assistant turn");

	const toolResult: ToolResultMessage<unknown> = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "large-context",
		content: [{ type: "text", text: "x".repeat(800_000) }],
		isError: false,
		timestamp: assistantMessage.timestamp + 1,
	};
	const messages: AgentMessage[] = [...harness.session.agent.state.messages, toolResult];
	harness.session.agent.state.messages = messages;

	const internals = harness.session as unknown as SessionThresholdInternals;
	const parked = await internals._shouldStopAfterTurn({
		message: assistantMessage,
		toolResults: [toolResult],
		context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
		newMessages: [assistantMessage, toolResult],
	});
	await internals._checkCompaction(assistantMessage);

	return {
		parked,
		compactionReasons: harness.eventsOfType("compaction_start").map((event) => event.reason),
	};
}

describe("#913 one owner decides whether the server holds the compaction threshold", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("neither parks nor compacts when the request carries a server threshold", async () => {
		const harness = await createOpenAIHarness(OPENAI_ENDPOINT, {
			compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
		});
		harnesses.push(harness);

		const outcome = await driveOverThreshold(harness);

		// The park without an unpark is the defect: stopping here left the loop stuck.
		expect(outcome.parked).toBe(false);
		expect(outcome.compactionReasons).toEqual([]);
	});

	it("parks and compacts when the window is smaller than the reserve", async () => {
		// openai/gpt-4's window. 8192 - 16384 is negative, so no positive `compact_threshold`
		// exists to send. The endpoint looks server-compacting but compacts nothing, so the
		// local threshold has to keep running.
		const harness = await createOpenAIHarness(OPENAI_ENDPOINT, {
			compaction: { enabled: true, keepRecentTokens: 1 },
		});
		harnesses.push(harness);
		expect(harness.settingsManager.getCompactionSettings().reserveTokens).toBeGreaterThan(8192);

		const outcome = await driveOverThreshold(harness, 8192);

		expect(outcome.parked).toBe(true);
		expect(outcome.compactionReasons).toEqual(["threshold"]);
	});

	it("parks and compacts when the endpoint does not take context management", async () => {
		const harness = await createOpenAIHarness("https://proxy.example/v1", {
			compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
		});
		harnesses.push(harness);

		const outcome = await driveOverThreshold(harness);

		expect(outcome.parked).toBe(true);
		expect(outcome.compactionReasons).toEqual(["threshold"]);
	});

	it("hands the parked loop back to itself when the compaction finishes", async () => {
		const harness = await createOpenAIHarness("https://proxy.example/v1", {
			compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
		});
		harnesses.push(harness);

		const outcome = await driveOverThreshold(harness);
		expect(outcome.parked).toBe(true);
		expect(outcome.compactionReasons).toEqual(["threshold"]);

		// The park stopped the loop between a tool result and the next turn, so the
		// compaction that follows has to restart it. `_schedulePostCompactionContinue` is
		// that handoff: without it the loop stays stopped with no message to the user.
		// The turn it starts 100 ms later cannot be driven from here — `_performCompaction`
		// rebuilds `agent.state.messages` from the session, which never held the oversized
		// tool result this test injects, so the rebuilt history has nothing left to continue.
		const internals = harness.session as unknown as SessionThresholdInternals;
		expect(internals._postCompactionContinuationScheduled).toBe(true);
	});
});
