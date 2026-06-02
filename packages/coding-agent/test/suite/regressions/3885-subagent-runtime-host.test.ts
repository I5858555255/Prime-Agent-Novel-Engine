import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { SessionManager } from "../../../src/core/session-manager.js";

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(10);
	}
}

describe("ENG-3885 subagent runtime host", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("creates running RLM children as tracked AgentSessionRuntime instances", async () => {
		const tempDir = join(tmpdir(), `pi-3885-subagent-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-parent", reasoning: true },
				{ id: "faux-child", reasoning: false },
			],
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			})),
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
			runtimeOptions,
		}) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions?.model ?? faux.getModel(),
					thinkingLevel: runtimeOptions?.thinkingLevel ?? "off",
					scopedModels: runtimeOptions?.scopedModels,
					initialActiveToolNames: runtimeOptions?.initialActiveToolNames,
					allowedToolNames: runtimeOptions?.allowedToolNames,
					customTools: runtimeOptions?.customTools,
					includeGoalTools: runtimeOptions?.includeGoalTools,
					autoActivateGoalTools: runtimeOptions?.autoActivateGoalTools,
					rlmDepth: runtimeOptions?.rlmDepth,
					rlmMaxDepth: runtimeOptions?.rlmMaxDepth,
					rlmSessionDir: runtimeOptions?.rlmSessionDir,
					rlmParentNodeId: runtimeOptions?.rlmParentNodeId,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.setModel(faux.getModel("faux-child")!);

		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		let childModelId: string | undefined;
		faux.setResponses([
			async (_context, _options, _state, model) => {
				childStarted = true;
				childModelId = model.id;
				await release;
				return fauxAssistantMessage(`child answer from ${model.id}`);
			},
		]);

		const resultPromise = runtime.session.runRlmChild("inspect child runtime");

		await waitFor(() => childStarted && runtime.listSubagentRuntimes().length === 1);
		const [childRuntime] = runtime.listSubagentRuntimes();
		expect(childRuntime).toBeInstanceOf(AgentSessionRuntime);
		expect(childRuntime?.session.sessionId).not.toBe(runtime.session.sessionId);
		expect(childRuntime?.session.model?.id).toBe("faux-child");
		expect(childRuntime?.metadata).toEqual(
			expect.objectContaining({
				kind: "subagent",
				parentSessionId: runtime.session.sessionId,
				prompt: "inspect child runtime",
			}),
		);
		expect(childModelId).toBe("faux-child");

		releaseChild();
		const result = await resultPromise;

		expect(result.answer).toBe("child answer from faux-child");
		expect(result.session_dir).not.toBeNull();
		expect(runtime.listSubagentRuntimes()).toEqual([]);
	});
});
