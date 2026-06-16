import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentObserveController } from "../src/core/agent-observe.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("createAgentSessionFromServices", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
		while (unregisters.length > 0) {
			unregisters.pop()?.();
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("forwards daemon-backed agent observe controllers into AgentSession", async () => {
		const tempDir = join(tmpdir(), `pi-session-services-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const faux = registerFauxProvider();
		unregisters.push(() => faux.unregister());

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		services.modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});

		const agentObserveController: AgentObserveController = {
			listAgents: () => ({
				current: {
					activeSessionId: "current",
					sessionId: "session-current",
					cwd: tempDir,
					status: "idle",
					isCurrent: true,
					isStreaming: false,
					isCompacting: false,
					attachedClients: 0,
					messageCount: 0,
					pendingMessageCount: 0,
				},
				agents: [],
			}),
			getAgent: (target) => ({
				agent: {
					activeSessionId: target,
					sessionId: "session-worker",
					cwd: tempDir,
					status: "idle",
					isCurrent: false,
					isStreaming: false,
					isCompacting: false,
					attachedClients: 0,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			}),
			recentMessages: (input) => ({
				agent: {
					activeSessionId: input.target,
					sessionId: "session-worker",
					cwd: tempDir,
					status: "idle",
					isCurrent: false,
					isStreaming: false,
					isCompacting: false,
					attachedClients: 0,
					messageCount: 0,
					pendingMessageCount: 0,
				},
				messages: [],
				limit: input.limit ?? 8,
				maxChars: input.maxChars ?? 800,
				truncated: false,
			}),
		};

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			model: faux.getModel(),
			agentObserveController,
		});

		try {
			expect(session.handleAgentObserveHostRequest("agent_observe.list")).toMatchObject({
				current: { activeSessionId: "current" },
			});
		} finally {
			session.dispose();
		}
	});
});
