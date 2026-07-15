import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { assistantMsg, createTestResourceLoader, userMsg } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4620 fast mode settings", () => {
	let harness: Harness | undefined;
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) {
			session.dispose();
		}
		harness?.cleanup();
		harness = undefined;
	});

	it("uses the saved fast mode preference for new sessions", async () => {
		harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id: "gpt-5.4" }],
		});
		const currentHarness = harness;

		currentHarness.session.setServiceTier("priority");
		expect(currentHarness.settingsManager.getDefaultServiceTier()).toBe("priority");

		const createSession = () =>
			createAgentSession({
				cwd: currentHarness.tempDir,
				authStorage: currentHarness.authStorage,
				model: currentHarness.getModel(),
				resourceLoader: createTestResourceLoader(),
				sessionManager: SessionManager.inMemory(currentHarness.tempDir),
				settingsManager: currentHarness.settingsManager,
			});

		const { session } = await createSession();
		sessions.push(session);
		expect(session.serviceTier).toBe("priority");

		session.setServiceTier("default");
		const { session: nextSession } = await createSession();
		sessions.push(nextSession);
		expect(nextSession.serviceTier).toBe("default");
	});

	it("persists the preference across settings manager restarts", async () => {
		harness = await createHarness();
		const agentDir = join(harness.tempDir, "agent");
		const settingsManager = SettingsManager.create(harness.tempDir, agentDir);

		settingsManager.setDefaultServiceTier("priority");
		await settingsManager.flush();

		const reloadedSettingsManager = SettingsManager.create(harness.tempDir, agentDir);
		expect(reloadedSettingsManager.getDefaultServiceTier()).toBe("priority");
	});

	it("restores the saved preference after leaving an unsupported model", async () => {
		harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id: "gpt-5.4" }, { id: "gpt-5.3" }],
		});

		harness.session.setServiceTier("priority");
		await harness.session.setModel(harness.getModel("gpt-5.3")!);

		expect(harness.session.serviceTier).toBe("default");
		expect(harness.settingsManager.getDefaultServiceTier()).toBe("priority");

		await harness.session.setModel(harness.getModel("gpt-5.4")!);
		expect(harness.session.serviceTier).toBe("priority");
	});

	it("preserves fast mode while navigating session history", async () => {
		harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [{ id: "gpt-5.4" }],
		});

		const targetId = harness.sessionManager.appendMessage(userMsg("first"));
		harness.sessionManager.appendMessage(assistantMsg("reply"));
		harness.session.setServiceTier("priority");
		harness.sessionManager.appendMessage(userMsg("second"));

		await harness.session.navigateTree(targetId, { summarize: false });

		expect(harness.session.serviceTier).toBe("priority");
	});
});
