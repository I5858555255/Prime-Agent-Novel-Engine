import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, StreamOptions, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	estimateContextTokens,
	estimateMessageTokens,
	getServerCompactionThreshold,
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

const usage: Usage = {
	input: 250000,
	output: 10000,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 260000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("getServerCompactionThreshold", () => {
	it("uses Prime Agent reserved output space", () => {
		expect(
			getServerCompactionThreshold(openAIModel.contextWindow, {
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
			}),
		).toBe(1033616);
	});

	it("returns undefined when disabled or the reserve consumes the context window", () => {
		expect(
			getServerCompactionThreshold(openAIModel.contextWindow, {
				enabled: false,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
			}),
		).toBeUndefined();
		expect(
			getServerCompactionThreshold(openAIModel.contextWindow, {
				enabled: true,
				reserveTokens: 1050000,
				keepRecentTokens: 20000,
			}),
		).toBeUndefined();
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

describe("server-compacted context usage", () => {
	it("estimates from the opaque compaction boundary instead of stale pre-compaction usage", () => {
		const compactedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "continued after compaction" }],
			api: openAIModel.api,
			provider: openAIModel.provider,
			model: openAIModel.id,
			openaiCompaction: {
				item: { type: "compaction", id: "cmp_1", encrypted_content: "x".repeat(400) },
				contentIndex: 0,
				sourceBaseUrl: openAIModel.baseUrl,
			},
			contextTokenScope: {
				api: openAIModel.api,
				provider: openAIModel.provider,
				model: openAIModel.id,
				baseUrl: openAIModel.baseUrl,
			},
			contextTokens: null,
			usage,
			stopReason: "stop",
			timestamp: 3,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: "old input", timestamp: 1 },
			{
				...compactedAssistant,
				openaiCompaction: undefined,
				timestamp: 2,
			},
			compactedAssistant,
			{ role: "user", content: "new input", timestamp: 4 },
		];
		const estimate = estimateContextTokens(messages, openAIModel);

		expect(estimate.lastUsageIndex).toBe(2);
		expect(estimate.tokens).toBeNull();
		expect(estimate.usageTokens).toBeNull();

		const switchedModel = { ...openAIModel, id: "gpt-5.6-terra" };
		const switchedEstimate = estimateContextTokens(messages, switchedModel);
		expect(switchedEstimate.usageTokens).toBe(0);
		expect(switchedEstimate.tokens).toBe(estimateMessageTokens(messages));

		const foreignResponse: AssistantMessage = {
			...compactedAssistant,
			model: switchedModel.id,
			openaiCompaction: undefined,
			contextTokens: undefined,
			timestamp: 5,
		};
		const returnedEstimate = estimateContextTokens([...messages, foreignResponse], openAIModel);
		expect(returnedEstimate.tokens).toBeNull();

		const endpointEstimate = estimateContextTokens(messages, {
			...openAIModel,
			baseUrl: "https://proxy.example/v1",
		});
		expect(endpointEstimate.tokens).toBe(estimateMessageTokens(messages));

		const continuedResponse: AssistantMessage = {
			...compactedAssistant,
			openaiCompaction: undefined,
			contextTokens: undefined,
			timestamp: 6,
		};
		const sameEndpointEstimate = estimateContextTokens([...messages, continuedResponse], openAIModel);
		expect(sameEndpointEstimate.tokens).toBe(usage.totalTokens);
		const changedEndpointEstimate = estimateContextTokens([...messages, continuedResponse], {
			...openAIModel,
			baseUrl: "https://proxy.example/v1",
		});
		expect(changedEndpointEstimate.tokens).toBe(estimateMessageTokens([...messages, continuedResponse]));
	});
	it("persists checkpoint and token scope through a SessionManager reopen", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "prime-server-compaction-"));
		try {
			const manager = SessionManager.create(process.cwd(), sessionDir);
			manager.appendModelChange(openAIModel.provider, openAIModel.id);
			manager.appendMessage({ role: "user", content: "old input", timestamp: 1 });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "after checkpoint" }],
				api: openAIModel.api,
				provider: openAIModel.provider,
				model: openAIModel.id,
				openaiCompaction: {
					item: { type: "compaction", id: "cmp_persisted", encrypted_content: "opaque" },
					contentIndex: 0,
					sourceBaseUrl: openAIModel.baseUrl,
				},
				contextTokenScope: {
					api: openAIModel.api,
					provider: openAIModel.provider,
					model: openAIModel.id,
					baseUrl: openAIModel.baseUrl,
				},
				contextTokens: null,
				usage,
				stopReason: "stop",
				timestamp: 2,
			});
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();

			const restored = SessionManager.open(sessionFile!);
			const assistant = restored.buildSessionContext().messages.at(-1) as AssistantMessage;
			expect(assistant.openaiCompaction?.item.id).toBe("cmp_persisted");
			expect(assistant.contextTokenScope?.baseUrl).toBe(openAIModel.baseUrl);
			expect(assistant.contextTokens).toBeNull();
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
