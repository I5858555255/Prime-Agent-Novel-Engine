import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { CustomMessage } from "../../../src/core/messages.js";
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
	_pendingNextTurnMessages: CustomMessage[];
	_acceptedAgentMessagePrompt?: {
		text: string;
		agentMessageId: string;
		message: UserMessage;
		messages: Set<unknown>;
		pendingNextTurnMessages: CustomMessage[];
		accepted: Promise<void>;
		resolveAccepted: () => void;
		rejectAccepted: (error: Error) => void;
		turnStarted: boolean;
		cleared: boolean;
	};
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

function createCustomMessage(content: string): CustomMessage {
	return {
		role: "custom",
		customType: "prime-agent.test",
		content,
		display: false,
		timestamp: Date.now(),
	};
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

	it("captures next-turn context and accepted prompts in the restart manifest", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);

		const pendingNextTurn = createCustomMessage("pending next turn");
		const acceptedNextTurn = createCustomMessage("accepted prompt context");
		const acceptedMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "accepted work" }],
			timestamp: Date.now(),
		};
		const queueInternals = harness.session as unknown as QueueInternals;
		queueInternals._pendingNextTurnMessages = [pendingNextTurn];
		queueInternals._acceptedAgentMessagePrompt = {
			text: "accepted work",
			agentMessageId: "agent-message-1",
			message: acceptedMessage,
			messages: new Set([acceptedNextTurn, acceptedMessage]),
			pendingNextTurnMessages: [acceptedNextTurn],
			accepted: Promise.resolve(),
			resolveAccepted: () => undefined,
			rejectAccepted: () => undefined,
			turnStarted: false,
			cleared: false,
		};

		const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
			defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonUpdateInternals;
		internals.sessions.set(
			"active-1",
			createState(harness, "active-1", { kind: "top-level", createdAt: Date.now() }),
		);

		const manifest = await internals.prepareUpdateRestart();

		expect(manifest.sessions).toHaveLength(1);
		expect(manifest.sessions[0]).toMatchObject({
			activeSessionId: "active-1",
			shouldResume: true,
			hadAcceptedPromptInFlight: true,
		});
		expect(manifest.sessions[0]?.queue.nextTurn).toEqual([pendingNextTurn]);
		expect(manifest.sessions[0]?.queue.acceptedPrompt).toEqual({
			message: "accepted work",
			nextTurn: [acceptedNextTurn],
		});
	});
});
