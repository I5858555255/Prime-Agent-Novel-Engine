/**
 * Regression for #913: a local compaction's summary never reached the model.
 *
 * `convertResponsesMessages` scans backwards for the newest replayable OpenAI compaction
 * checkpoint and sends only the messages from that turn on. A local compaction rebuilds the
 * context summary-first, then the retained messages — and a retained assistant turn still
 * carried its checkpoint. The scan found it and sliced the summary away, so `/compact`
 * reported success in the UI while the model saw none of it.
 *
 * The chain under test is the real one: AgentSession.compact -> SessionManager rebuild ->
 * convertToLlm -> convertResponsesMessages. Mocking `_runAutoCompaction`, as the
 * characterization suite does, cannot see the result being discarded.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
// The converter that builds the request body, imported from source so the wire the model
// reads is the real one.
import { convertResponsesMessages } from "../../../../ai/src/providers/openai-responses-shared.js";
import { DEFAULT_COMPACTION_SETTINGS, getSentServerCompactionThreshold } from "../../../src/core/compaction/index.js";
import { convertToLlm } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1";
const SYSTEM_PROMPT = "You are a test assistant.";
const SUMMARY = "the summary a local compaction wrote";

const requestModel: Model<"openai-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: OPENAI_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 128_000,
};

/** A turn the OpenAI server compacted, the way the provider records one. */
function checkpointedResponse(text: string, id: string): AssistantMessage {
	return {
		...fauxAssistantMessage(text),
		openaiCompaction: {
			item: { type: "compaction", id, encrypted_content: "opaque" },
			sourceBaseUrl: OPENAI_ENDPOINT,
		},
	};
}

function toWire(messages: Message[]) {
	return convertResponsesMessages(
		requestModel,
		{ systemPrompt: SYSTEM_PROMPT, messages },
		new Set([requestModel.provider]),
		// The threshold a session on this endpoint sends. A request that carries none asks
		// the server for no compaction and replays no checkpoint, so it would hide the slice
		// this test is about.
		{ serverCompactionThreshold: getSentServerCompactionThreshold(requestModel, DEFAULT_COMPACTION_SETTINGS) },
	);
}

describe("#913 a local compaction summary reaches the model", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps the summary on the wire after the server compacted the retained turns", async () => {
		const harness = await createHarness({
			api: requestModel.api,
			provider: requestModel.provider,
			persistSession: true,
			systemPrompt: SYSTEM_PROMPT,
			settings: { compaction: { keepRecentTokens: 1 } },
			models: [{ id: requestModel.id, contextWindow: requestModel.contextWindow }],
		});
		harnesses.push(harness);
		Object.assign(harness.getModel(), { baseUrl: OPENAI_ENDPOINT });
		harness.setResponses([
			checkpointedResponse("first answer", "cmp_1"),
			checkpointedResponse("second answer", "cmp_2"),
			fauxAssistantMessage(SUMMARY),
			fauxAssistantMessage("turn prefix summary"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const result = await harness.session.compact("focus on X");
		expect(result.summary).toContain(SUMMARY);

		const rebuilt = harness.sessionManager.buildSessionContext().messages;
		expect(rebuilt[0].role).toBe("compactionSummary");
		const retained = rebuilt.filter((message): message is AssistantMessage => message.role === "assistant");
		expect(retained.length).toBeGreaterThan(0);
		expect(retained.filter((message) => message.openaiCompaction !== undefined)).toEqual([]);

		// Read after the rebuild: the entries are the session file's own record, which every
		// later reader rebuilds from, so the rebuild has to leave them alone — including the
		// retained turn it just stripped a checkpoint off.
		const persisted = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(persisted.map((message) => message.openaiCompaction?.item.id)).toEqual(["cmp_1", "cmp_2"]);
		const persistedCheckpoint = persisted.at(-1)?.openaiCompaction;

		const wire = JSON.stringify(toWire(convertToLlm(rebuilt)));
		expect(wire).toContain(SUMMARY);
		expect(wire).not.toContain('"type":"compaction"');

		// Why the strip matters: put the checkpoint back on the retained turn and the
		// converter slices the context at it, dropping the summary that sits ahead of it.
		const withCheckpoint = rebuilt.map((message) =>
			message.role === "assistant" ? { ...message, openaiCompaction: persistedCheckpoint } : message,
		);
		const slicedWire = JSON.stringify(toWire(convertToLlm(withCheckpoint)));
		expect(slicedWire).not.toContain(SUMMARY);
		expect(slicedWire).toContain('"type":"compaction"');
	});

	it("keeps the summary on the wire for the live session context too", async () => {
		const harness = await createHarness({
			api: requestModel.api,
			provider: requestModel.provider,
			systemPrompt: SYSTEM_PROMPT,
			settings: { compaction: { keepRecentTokens: 1 } },
			models: [{ id: requestModel.id, contextWindow: requestModel.contextWindow }],
		});
		harnesses.push(harness);
		Object.assign(harness.getModel(), { baseUrl: OPENAI_ENDPOINT });
		harness.setResponses([
			checkpointedResponse("first answer", "cmp_1"),
			checkpointedResponse("second answer", "cmp_2"),
			fauxAssistantMessage(SUMMARY),
			fauxAssistantMessage("turn prefix summary"),
		]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.compact("focus on X");

		// The agent's own message list is rebuilt from the same session context, so the
		// next live request carries the summary as well.
		const live = harness.session.agent.state.messages;
		expect(live.filter((message) => message.role === "assistant").length).toBeGreaterThan(0);
		const wire = JSON.stringify(toWire(convertToLlm(live)));
		expect(wire).toContain(SUMMARY);
		expect(wire).not.toContain('"type":"compaction"');
	});
});
