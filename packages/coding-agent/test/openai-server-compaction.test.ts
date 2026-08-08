import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, StreamOptions, Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
// The provider that writes the fields the estimator reads. Imported from source so the
// fixtures below come from production instead of being written by hand.
import { streamOpenAIResponses } from "../../ai/src/providers/openai-responses.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	type CompactionSettings,
	type ContextModel,
	contextEndpointFor,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateMessageTokens,
	getSentServerCompactionThreshold,
	prepareCompaction,
} from "../src/core/compaction/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const openAIModel: Model<"openai-responses"> = {
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

const defaultSettings = SettingsManager.inMemory().getCompactionSettings();

/** The request a session on this model sends: where it goes and what threshold it carries. */
function endpoint(model: ContextModel, settings: CompactionSettings = defaultSettings) {
	return contextEndpointFor(model, settings);
}

const anthropicModel: ContextModel = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	baseUrl: "https://api.anthropic.com",
	contextWindow: 200000,
};

const usage: Usage = {
	input: 250000,
	output: 10000,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 260000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("getSentServerCompactionThreshold", () => {
	it("reserves Prime Agent's output space out of the window it sends", () => {
		expect(
			getSentServerCompactionThreshold(openAIModel, {
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
			}),
		).toBe(1033616);
	});

	it("sends none when the reserve consumes the whole context window", () => {
		expect(
			getSentServerCompactionThreshold(openAIModel, {
				enabled: true,
				reserveTokens: 1050000,
				keepRecentTokens: 20000,
			}),
		).toBeUndefined();
	});

	it("sends a threshold to a supported endpoint with room for one", () => {
		expect(getSentServerCompactionThreshold(openAIModel, defaultSettings)).toBe(
			openAIModel.contextWindow - defaultSettings.reserveTokens,
		);
	});

	it("sends none to a model whose window is smaller than the reserve", () => {
		// openai/gpt-4 is on the official Responses endpoint, so it looks server-compacting,
		// but 8192 - 16384 is negative: no positive `compact_threshold` exists to send. The
		// server compacts nothing, so the local threshold has to keep running.
		const gpt4 = getModel("openai", "gpt-4");
		expect(gpt4?.contextWindow).toBe(8192);
		expect(defaultSettings.reserveTokens).toBeGreaterThan(8192);
		expect(getSentServerCompactionThreshold(gpt4, defaultSettings)).toBeUndefined();
	});

	it("sends none to an endpoint that does not take context management", () => {
		expect(
			getSentServerCompactionThreshold({ ...openAIModel, baseUrl: "https://proxy.example/v1" }, defaultSettings),
		).toBeUndefined();
	});

	it("sends none when compaction is turned off", () => {
		expect(getSentServerCompactionThreshold(openAIModel, { ...defaultSettings, enabled: false })).toBeUndefined();
	});
});

describe("SDK compaction wiring", () => {
	it("passes enabled and disabled thresholds into provider options", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(openAIModel.provider, "test-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory();
		let captured: StreamOptions | undefined;
		modelRegistry.registerProvider("compaction-wiring-test", {
			api: "openai-responses",
			streamSimple: (_model, _context, options) => {
				captured = options;
				throw new Error("captured provider options");
			},
		});

		try {
			const { session } = await createAgentSession({
				model: openAIModel,
				authStorage,
				modelRegistry,
				settingsManager,
				sessionManager,
				resourceLoader: createTestResourceLoader(),
			});
			await expect(session.agent.streamFn(openAIModel, { messages: [] })).rejects.toThrow(
				"captured provider options",
			);
			expect(captured?.serverCompactionThreshold).toBe(1033616);

			settingsManager.setCompactionEnabled(false);
			await expect(session.agent.streamFn(openAIModel, { messages: [] })).rejects.toThrow(
				"captured provider options",
			);
			expect(captured?.serverCompactionThreshold).toBeUndefined();
			session.dispose();
		} finally {
			modelRegistry.unregisterProvider("compaction-wiring-test");
		}
	});
});

/** The opaque checkpoint an OpenAI Responses server hands back on this endpoint. */
function serverCheckpoint(id = "cmp_1", encryptedContent = "opaque") {
	return {
		item: { type: "compaction" as const, id, encrypted_content: encryptedContent },
		sourceBaseUrl: openAIModel.baseUrl,
	};
}

describe("server-compacted context usage", () => {
	/**
	 * What production stamps on a turn whose request replayed a checkpoint.
	 *
	 * Every estimator fixture below is built from this instead of writing the fields by
	 * hand. A fixture that supplies them answers the question the tests are asking: delete
	 * the pre-set in openai-responses.ts and these cases have to go red.
	 */
	let capturedReplayTurn: AssistantMessage | undefined;

	/**
	 * Run the real provider up to the payload boundary and take the turn it built. The
	 * onPayload throw stops the request before any network call; the provider reports that
	 * failure as an error event carrying the message it had already stamped.
	 *
	 * The threshold is the one the session would send, because a request carrying none
	 * replays no checkpoint and so stamps no scope.
	 */
	async function captureAssistantTurn(
		requestModel: Model<"openai-responses">,
		messages: Message[],
	): Promise<AssistantMessage> {
		const request = streamOpenAIResponses(
			requestModel,
			{ messages },
			{
				apiKey: "test-key",
				serverCompactionThreshold: getSentServerCompactionThreshold(requestModel, defaultSettings),
				onPayload: () => {
					throw new Error("payload captured");
				},
			},
		);
		for await (const event of request) {
			if (event.type === "error") return event.error;
		}
		throw new Error("provider request did not stop at the payload boundary");
	}

	beforeAll(async () => {
		capturedReplayTurn = await captureAssistantTurn(openAIModel, [
			{ role: "user", content: "old input", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "checkpointed turn" }],
				api: openAIModel.api,
				provider: openAIModel.provider,
				model: openAIModel.id,
				openaiCompaction: serverCheckpoint(),
				usage,
				stopReason: "stop",
				timestamp: 2,
			},
		]);
	});

	/** A response on `openAIModel` whose request replayed a checkpoint, so its usage is scoped. */
	function replayResponse(text: string, timestamp: number): AssistantMessage {
		if (!capturedReplayTurn) throw new Error("provider turn was not captured");
		const { api, provider, model, contextTokenBaseUrl } = capturedReplayTurn;
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api,
			provider,
			model,
			contextTokenBaseUrl,
			usage,
			stopReason: "stop",
			timestamp,
		};
	}

	/** A response whose own request replayed no checkpoint, so its usage sizes the whole history. */
	function wholeHistoryResponse(text: string, timestamp: number, modelId = openAIModel.id): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: openAIModel.api,
			provider: openAIModel.provider,
			model: modelId,
			usage,
			stopReason: "stop",
			timestamp,
		};
	}

	it("takes the replay scope from the provider instead of writing it into the fixture", () => {
		expect(capturedReplayTurn).toMatchObject({
			api: openAIModel.api,
			provider: openAIModel.provider,
			model: openAIModel.id,
			contextTokenBaseUrl: openAIModel.baseUrl,
		});
	});

	it("estimates from the opaque compaction boundary instead of stale pre-compaction usage", () => {
		const compactedAssistant: AssistantMessage = {
			...replayResponse("continued after compaction", 3),
			openaiCompaction: serverCheckpoint("cmp_1", "x".repeat(400)),
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "old input", timestamp: 1 },
			replayResponse("earlier reply", 2),
			compactedAssistant,
			{ role: "user", content: "new input", timestamp: 4 },
		];
		const estimate = estimateContextTokens(messages, endpoint(openAIModel));

		expect(estimate.lastUsageIndex).toBeNull();
		expect(estimate.tokens).toBeNull();

		// Another model id cannot replay the checkpoint, so it receives the whole history.
		// Every reported usage here was measured under a replay, so none of them sizes that
		// history: the answer is unknown, not a chars/4 count a caller would read as a
		// measurement.
		const switchedModel = { ...openAIModel, id: "gpt-5.6-terra" };
		expect(estimateContextTokens(messages, endpoint(switchedModel)).tokens).toBeNull();

		// The other model's request replayed nothing, so its usage measured the whole
		// history. Coming back, the checkpoint applies again and shortens the context by
		// an amount that response never saw.
		const foreignResponse = wholeHistoryResponse("answered elsewhere", 5, switchedModel.id);
		expect(estimateContextTokens([...messages, foreignResponse], endpoint(openAIModel)).tokens).toBeNull();

		// That same response does size the whole history for the model that produced it.
		const switchedEstimate = estimateContextTokens([...messages, foreignResponse], endpoint(switchedModel));
		expect(switchedEstimate.tokens).toBe(usage.totalTokens);
		expect(switchedEstimate.lastUsageIndex).toBe(4);

		const endpointEstimate = estimateContextTokens(
			messages,
			endpoint({ ...openAIModel, baseUrl: "https://proxy.example/v1" }),
		);
		expect(endpointEstimate.tokens).toBeNull();

		// A response whose own request replayed the same checkpoint did measure the
		// context the next request sends.
		const continuedResponse = replayResponse("continued on the same endpoint", 6);
		const sameEndpointEstimate = estimateContextTokens([...messages, continuedResponse], endpoint(openAIModel));
		expect(sameEndpointEstimate.tokens).toBe(usage.totalTokens);
		const changedEndpointEstimate = estimateContextTokens(
			[...messages, continuedResponse],
			endpoint({ ...openAIModel, baseUrl: "https://proxy.example/v1" }),
		);
		expect(changedEndpointEstimate.tokens).toBeNull();
	});

	it("walks back past a checkpointed response to one that sized the whole history", () => {
		// The plain response measured everything up to itself and nothing has replayed a
		// checkpoint since, so it still sizes what the next request to another provider
		// sends. Only the model id and the checkpoint differ from the response above it.
		const messages: AgentMessage[] = [
			{ role: "user", content: "old input", timestamp: 1 },
			wholeHistoryResponse("sized the whole history", 2, "gpt-5.6-terra"),
			{ role: "user", content: "more input", timestamp: 3 },
			{
				...replayResponse("answered under a checkpoint", 4),
				openaiCompaction: serverCheckpoint(),
			},
		];

		const estimate = estimateContextTokens(messages, endpoint(anthropicModel));
		expect(estimate.lastUsageIndex).toBe(1);
		expect(estimate.tokens).toBe(usage.totalTokens + estimateMessageTokens(messages.slice(2)));
	});

	it("keeps the measurement above a checkpoint the next request will not replay", () => {
		// A checkpoint the request replays ends the walk: nothing before it is sent, so no
		// older measurement describes the new context. A checkpoint it will NOT replay ends
		// nothing — the whole history goes out and the plain response that sized it still
		// applies. Which of the two it is has to be answered by the same rule the request
		// builder uses.
		const withCheckpoint = (checkpointTurn: AssistantMessage): AgentMessage[] => [
			{ role: "user", content: "old input", timestamp: 1 },
			wholeHistoryResponse("sized the whole history", 2),
			checkpointTurn,
			{ role: "user", content: "new input", timestamp: 4 },
		];
		const liveCheckpoint = withCheckpoint({
			...replayResponse("answered under a checkpoint", 3),
			openaiCompaction: serverCheckpoint(),
		});
		const wholeHistory = usage.totalTokens + estimateMessageTokens(liveCheckpoint.slice(2));

		// The endpoint that issued the checkpoint replays it, so the size is unknown.
		expect(estimateContextTokens(liveCheckpoint, endpoint(openAIModel)).tokens).toBeNull();

		// The same endpoint with server compaction turned off sends no `context_management`,
		// so it cannot be handed the checkpoint back.
		const optedOut = { ...openAIModel, compat: { supportsServerCompaction: false } };
		expect(estimateContextTokens(liveCheckpoint, endpoint(optedOut)).tokens).toBe(wholeHistory);

		// Another server-compacting endpoint takes `context_management` but not this
		// checkpoint: the blob is opaque to every server but the one that wrote it.
		const otherEndpoint = {
			...openAIModel,
			baseUrl: "https://proxy.example/v1",
			compat: { supportsServerCompaction: true },
		};
		expect(estimateContextTokens(liveCheckpoint, endpoint(otherEndpoint)).tokens).toBe(wholeHistory);

		// A stream that failed after the server emitted the checkpoint leaves it on a turn
		// the request builder drops, so that checkpoint is never replayed either.
		const erroredCheckpoint = withCheckpoint({
			...replayResponse("stream died after the checkpoint", 3),
			openaiCompaction: serverCheckpoint(),
			stopReason: "error",
		});
		expect(estimateContextTokens(erroredCheckpoint, endpoint(openAIModel)).tokens).toBe(
			usage.totalTokens + estimateMessageTokens(erroredCheckpoint.slice(2)),
		);

		// Compaction turned off means the request carries no `compact_threshold`, so it asks
		// for no server compaction and is handed no checkpoint back either.
		const compactionOff = endpoint(openAIModel, { ...defaultSettings, enabled: false });
		expect(estimateContextTokens(liveCheckpoint, compactionOff).tokens).toBe(wholeHistory);
	});

	it("does not replay a checkpoint to an endpoint that only differs by provider or api", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "old input", timestamp: 1 },
			wholeHistoryResponse("sized the whole history", 2),
			{ ...replayResponse("answered under a checkpoint", 3), openaiCompaction: serverCheckpoint() },
			{ role: "user", content: "new input", timestamp: 4 },
		];
		const wholeHistory = usage.totalTokens + estimateMessageTokens(messages.slice(2));

		// `compat` keeps server compaction on for both, so the support gate cannot stand in
		// for the identity rule: one field of the endpoint differs and nothing else.
		const otherProvider = {
			...openAIModel,
			provider: "openai-compatible",
			compat: { supportsServerCompaction: true },
		};
		expect(estimateContextTokens(messages, endpoint(otherProvider)).tokens).toBe(wholeHistory);

		const otherApi = {
			...openAIModel,
			api: "openai-codex-responses" as const,
			compat: { supportsServerCompaction: true },
		};
		expect(estimateContextTokens(messages, endpoint(otherApi)).tokens).toBe(wholeHistory);

		// The endpoint that issued the checkpoint still replays it.
		expect(estimateContextTokens(messages, endpoint(openAIModel)).tokens).toBeNull();
	});

	/** Two identities sending to one endpoint, each with its own checkpoint and a reply under it. */
	function twoCheckpointsOnOneEndpoint(other: { api: Api; provider: string; model: string }): AgentMessage[] {
		return [
			{ role: "user", content: "old input", timestamp: 1 },
			{ ...wholeHistoryResponse("compacted for this endpoint", 2), openaiCompaction: serverCheckpoint("cmp_here") },
			{ role: "user", content: "more input", timestamp: 3 },
			{
				...wholeHistoryResponse("compacted for the other identity", 4),
				...other,
				openaiCompaction: serverCheckpoint("cmp_other"),
			},
			{ ...replayResponse("continued over there", 5), ...other, usage: { ...usage, totalTokens: 7 } },
		];
	}

	it("rejects a measurement taken under a different checkpoint on the same endpoint", () => {
		const cases: Array<{
			label: string;
			other: { api: Api; provider: string; model: string };
			target: ContextModel;
		}> = [
			{
				label: "model",
				other: { api: openAIModel.api, provider: openAIModel.provider, model: "gpt-5.6-terra" },
				target: { ...openAIModel, id: "gpt-5.6-terra" },
			},
			{
				label: "provider",
				other: { api: openAIModel.api, provider: "openai-compatible", model: openAIModel.id },
				target: { ...openAIModel, provider: "openai-compatible", compat: { supportsServerCompaction: true } },
			},
			{
				label: "api",
				other: { api: "openai-codex-responses", provider: openAIModel.provider, model: openAIModel.id },
				target: { ...openAIModel, api: "openai-codex-responses", compat: { supportsServerCompaction: true } },
			},
		];

		for (const { label, other, target } of cases) {
			const messages = twoCheckpointsOnOneEndpoint(other);
			// This endpoint replays cmp_here, while the last reply measured an input built on
			// cmp_other. Same endpoint, different checkpoint, so that number is not this size.
			expect(estimateContextTokens(messages, endpoint(openAIModel)).tokens, label).toBeNull();
			// The other identity's own next request replays cmp_other, which is what it measured.
			expect(estimateContextTokens(messages, endpoint(target)).tokens, label).toBe(7);
		}
	});

	it("never reads a context size off the turn the server compacted", () => {
		// The first server compaction lands on a request that replayed nothing, so that turn
		// carries a checkpoint and no scope. Its `usage` is still not a context size: the
		// server shortened the context mid-turn and never said by how much. The distinct
		// total makes it obvious if the estimate is taken from that turn anyway.
		const compactedTurn: AssistantMessage = {
			...wholeHistoryResponse("the server compacted here", 3),
			openaiCompaction: serverCheckpoint(),
			usage: { ...usage, totalTokens: 999 },
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "old input", timestamp: 1 },
			wholeHistoryResponse("sized the whole history", 2),
			compactedTurn,
			{ role: "user", content: "new input", timestamp: 4 },
		];

		// An endpoint that will not replay the checkpoint receives the whole history, and
		// the response above the checkpoint is the one that measured it.
		const optedOut = { ...openAIModel, compat: { supportsServerCompaction: false } };
		const estimate = estimateContextTokens(messages, endpoint(optedOut));
		expect(estimate.lastUsageIndex).toBe(1);
		expect(estimate.tokens).toBe(usage.totalTokens + estimateMessageTokens(messages.slice(2)));
	});

	it("rejects a whole-history measurement when the next request replays a checkpoint", () => {
		// A response produced while the endpoint had server compaction turned off measured
		// the whole history and carries no scope. Turning it back on makes the next request
		// replay the checkpoint again, so that response no longer sizes what goes out.
		const messages: AgentMessage[] = [
			{ role: "user", content: "old input", timestamp: 1 },
			{ ...replayResponse("answered under a checkpoint", 2), openaiCompaction: serverCheckpoint() },
			wholeHistoryResponse("answered with server compaction turned off", 3),
		];

		expect(estimateContextTokens(messages, endpoint(openAIModel)).tokens).toBeNull();
		// With no endpoint to resolve, whether that checkpoint is replayed is unknowable, so
		// the size is unknown rather than that response's number.
		expect(estimateContextTokens(messages).tokens).toBeNull();
	});

	it("keeps the reported context size across a model switch with no checkpoint", () => {
		const anthropicResponse: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "answered before the switch" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "stop",
			timestamp: 2,
		};
		const messages: AgentMessage[] = [{ role: "user", content: "old input", timestamp: 1 }, anthropicResponse];

		// Nothing here was compacted on a server, so the reported usage still describes
		// what the next request sends, whichever model it goes to. A filter that only
		// accepted the response's own model would find nothing on the first prompt after a
		// switch and fall through to counting characters: 260,000 tokens read as ~26.
		const wholeHistoryEstimate = estimateMessageTokens(messages);
		expect(wholeHistoryEstimate).toBeLessThan(usage.totalTokens / 1000);
		const otherAnthropicModel: ContextModel = { ...anthropicModel, id: "claude-opus-4-5" };
		for (const target of [endpoint(openAIModel), endpoint(otherAnthropicModel), undefined]) {
			const estimate = estimateContextTokens(messages, target);
			expect(estimate.tokens).toBe(usage.totalTokens);
			expect(estimate.tokens).not.toBe(wholeHistoryEstimate);
			expect(estimate.lastUsageIndex).toBe(1);
		}
	});

	it("reports an unknown size when the endpoint cannot be resolved", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "old input", timestamp: 1 },
			{
				...replayResponse("after checkpoint", 2),
				openaiCompaction: serverCheckpoint(),
			},
		];

		expect(estimateContextTokens(messages).tokens).toBeNull();
	});

	it("drops the server checkpoint from the messages a local compaction retained", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "prime-local-compaction-"));
		try {
			const manager = SessionManager.create(process.cwd(), sessionDir);
			manager.appendModelChange(openAIModel.provider, openAIModel.id);
			manager.appendMessage({ role: "user", content: "old input", timestamp: 1 });
			// The first server compaction of a session: the request replayed nothing, so the
			// turn carries a checkpoint and no scope of its own.
			const keptId = manager.appendMessage({
				...wholeHistoryResponse("checkpointed turn", 2),
				openaiCompaction: serverCheckpoint("cmp_local"),
			});
			manager.appendCompaction("what happened so far", keptId, 260000);

			const messages = manager.buildSessionContext().messages;
			// The summary leads the context, as a plain user message by the time it reaches
			// a provider. A checkpoint on a retained turn would make the next request replay
			// it and drop everything ahead of it, the summary included.
			expect(messages[0].role).toBe("compactionSummary");
			expect(JSON.stringify(messages[0])).toContain("what happened so far");
			const retained = messages.filter((message) => message.role === "assistant") as AssistantMessage[];
			expect(retained).toHaveLength(1);
			expect(retained[0].openaiCompaction).toBeUndefined();
			// The server shortened that turn's input mid-stream, so its usage was never a
			// whole-history size. Dropping the checkpoint must not turn it into one.
			expect(retained[0].contextTokenBaseUrl).toBe(openAIModel.baseUrl);
			expect(estimateContextTokens(messages, endpoint(openAIModel)).tokens).toBeNull();
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("records the measured size on the compaction entry of a server-compacted session", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "prime-prepare-compaction-"));
		try {
			const manager = SessionManager.create(process.cwd(), sessionDir);
			manager.appendModelChange(openAIModel.provider, openAIModel.id);
			manager.appendMessage({ role: "user", content: "old input", timestamp: 1 });
			manager.appendMessage({
				...replayResponse("checkpointed turn", 2),
				openaiCompaction: serverCheckpoint("cmp_prepare"),
			});
			manager.appendMessage({ role: "user", content: "new input", timestamp: 3 });
			manager.appendMessage(replayResponse("measured the replayed context", 4));
			const entries = manager.getBranch();
			// Small enough that there is a turn to summarize, which is what makes a preparation.
			const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

			// `tokensBefore` is written onto the compaction entry and shown from then on, so it
			// reads the endpoint the session sends to like every other context number does.
			const preparation = prepareCompaction(entries, settings, endpoint(openAIModel));
			expect(preparation?.tokensBefore).toBe(usage.totalTokens);

			// Without an endpoint the replay is unknowable, so nothing measured this context
			// and the record falls back to counting characters — orders of magnitude under it.
			const unresolved = prepareCompaction(entries, settings);
			expect(unresolved?.tokensBefore).toBeLessThan(usage.totalTokens / 1000);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("persists the checkpoint and its context token endpoint through a SessionManager reopen", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "prime-server-compaction-"));
		try {
			const manager = SessionManager.create(process.cwd(), sessionDir);
			manager.appendModelChange(openAIModel.provider, openAIModel.id);
			manager.appendMessage({ role: "user", content: "old input", timestamp: 1 });
			manager.appendMessage({
				...replayResponse("after checkpoint", 2),
				openaiCompaction: serverCheckpoint("cmp_persisted"),
			});
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();

			const restored = SessionManager.open(sessionFile!);
			const assistant = restored.buildSessionContext().messages.at(-1) as AssistantMessage;
			expect(assistant.openaiCompaction?.item.id).toBe("cmp_persisted");
			expect(assistant.contextTokenBaseUrl).toBe(openAIModel.baseUrl);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
