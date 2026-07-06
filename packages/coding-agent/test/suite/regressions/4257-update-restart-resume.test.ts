import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { BashOperations } from "../../../src/core/tools/bash.js";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonUpdateRestartManifest } from "../../../src/modes/daemon/daemon-protocol.js";
import { createHarness, type Harness } from "../harness.js";

type AgentDaemonUpdateInternals = {
	sessions: Map<string, ActiveSessionState>;
	prepareUpdateRestart(): Promise<DaemonUpdateRestartManifest>;
};

describe("issue #4257 update restart resume", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("captures a restart manifest and aborts running bash without archiving the session", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.recordBashResult("echo before", {
			output: "before",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				return await new Promise<{ exitCode: number | null }>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							resolve({ exitCode: null });
						},
						{ once: true },
					);
				});
			},
		};
		const bashPromise = harness.session.executeBash("sleep", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.session.isBashRunning).toBe(true);

		let disposed = false;
		const runtime = {
			session: harness.session,
			metadata: { kind: "top-level" },
			runtimeConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			diagnostics: [],
			dispose: async () => {
				disposed = true;
			},
		} as unknown as AgentSessionRuntime;
		const state: ActiveSessionState = {
			activeSessionId: "active-1",
			runtime,
			clients: new Set(),
			extensionUiRequests: new Map(),
			lastEventSequence: 0,
		};
		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(state.activeSessionId, state);

		const manifest = await internals.prepareUpdateRestart();
		const bashResult = await bashPromise;

		expect(bashResult.cancelled).toBe(true);
		expect(disposed).toBe(true);
		expect(internals.sessions.size).toBe(0);
		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "active-1",
			sessionFile: harness.session.sessionFile,
			shouldResume: true,
			wasBashRunning: true,
		});
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "session_state" && entry.state.status === "archived"),
		).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "prime-agent.update_restart"),
		).toBe(true);
	});
});
