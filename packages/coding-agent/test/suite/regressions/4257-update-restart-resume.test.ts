import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
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

type QueueInternals = {
	_steeringMessages: Array<{ text: string; message: UserMessage }>;
};

function createState(
	harness: Harness,
	activeSessionId: string,
	metadata: AgentSessionRuntime["metadata"],
	options: { clientEnv?: Record<string, string>; onDispose?: () => void } = {},
): ActiveSessionState {
	const runtime = {
		session: harness.session,
		metadata,
		runtimeConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
		diagnostics: [],
		dispose: async () => {
			options.onDispose?.();
		},
	} as unknown as AgentSessionRuntime;
	return {
		activeSessionId,
		runtime,
		clients: new Set(),
		extensionUiRequests: new Map(),
		lastEventSequence: 0,
		...(options.clientEnv ? { clientEnv: options.clientEnv } : {}),
	};
}

function hasArchivedState(harness: Harness): boolean {
	return harness.sessionManager
		.getEntries()
		.some((entry) => entry.type === "session_state" && entry.state.status === "archived");
}

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
		const state = createState(
			harness,
			"active-1",
			{ kind: "top-level", createdAt: Date.now() },
			{
				onDispose: () => {
					disposed = true;
				},
			},
		);
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
		expect(hasArchivedState(harness)).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "prime-agent.update_restart"),
		).toBe(true);
	});

	it("keeps queued draft sessions resumable and archives non-restored subagents", async () => {
		const parentHarness = await createHarness({ persistSession: true });
		const childHarness = await createHarness({ persistSession: true });
		harnesses.push(parentHarness, childHarness);

		const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "queued work" }, image];
		const message: UserMessage = { role: "user", content, timestamp: Date.now() };
		(parentHarness.session as unknown as QueueInternals)._steeringMessages = [{ text: "queued work", message }];
		childHarness.session.recordBashResult("echo child", {
			output: "child",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		const daemon = new AgentDaemon(`${parentHarness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: parentHarness.tempDir, agentDir: parentHarness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"parent-active",
			createState(
				parentHarness,
				"parent-active",
				{ kind: "top-level", createdAt: Date.now() },
				{ clientEnv: { PRIME_SESSION: "pane-1" } },
			),
		);
		internals.sessions.set(
			"child-active",
			createState(childHarness, "child-active", {
				kind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: parentHarness.session.sessionId,
				parentSessionFile: parentHarness.session.sessionFile,
				createdAt: Date.now(),
				rlmChildId: "child-1",
			}),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(internals.sessions.size).toBe(0);
		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "parent-active",
			clientEnv: { PRIME_SESSION: "pane-1" },
			queue: { steering: [{ message: "queued work", images: [image] }], followUp: [] },
			shouldResume: true,
		});
		expect(hasArchivedState(parentHarness)).toBe(false);
		expect(hasArchivedState(childHarness)).toBe(true);
	});
});
