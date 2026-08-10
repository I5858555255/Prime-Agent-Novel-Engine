import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import {
	bindActiveSessionState,
	MAX_PENDING_EXTENSION_UI_NOTIFICATIONS,
} from "../../../src/modes/daemon/daemon-extension-binding.js";
import { AgentDaemon, cancelPendingExtensionUiRequests } from "../../../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerCommand } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { createHarness, type Harness } from "../harness.js";

interface DaemonInternals {
	sessions: Map<string, ActiveSessionState>;
	broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
	createAttachResult(
		client: DaemonSocketClient,
		state: ActiveSessionState,
		command: Extract<DaemonCommand, { type: "attach" }>,
	): Promise<DaemonAttachResult>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	handleWorkerCommand(client: DaemonSocketClient, command: DaemonWorkerCommand): Promise<void>;
}

interface SupervisorInternals {
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
}

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("Issue #1032 daemon session_start notifications", () => {
	it("delivers startup notifications once to the first extension-UI client", async () => {
		let notifyAfterAttach: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						ctx.ui.notify("startup one");
						expect(await ctx.ui.confirm("Confirm", "Continue?")).toBe(false);
						expect(await ctx.ui.select("Select", ["one", "two"])).toBeUndefined();
						expect(await ctx.ui.input("Input", "value")).toBeUndefined();
						ctx.ui.notify("startup two", "warning");
						notifyAfterAttach = () => ctx.ui.notify("attached notification");
					});
				},
			],
		});
		harnesses.push(harness);

		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);

		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		const incapable = createClient("incapable");
		await attach(internals, incapable.client, state.activeSessionId, false);
		await waitForImmediate();
		expect(extensionUiRequests(incapable.outbound)).toEqual([]);

		const first = createClient("first");
		await attach(internals, first.client, state.activeSessionId, true);
		await waitForImmediate();

		expect(extensionUiRequests(first.outbound)).toEqual([
			expect.objectContaining({ method: "notify", payload: { message: "startup one" } }),
			expect.objectContaining({
				method: "notify",
				payload: { message: "startup two", notifyType: "warning" },
			}),
		]);

		const second = createClient("second");
		await attach(internals, second.client, state.activeSessionId, true);
		await waitForImmediate();
		expect(extensionUiRequests(second.outbound)).toEqual([]);

		notifyAfterAttach?.();
		expect(extensionUiRequests(first.outbound).at(-1)).toMatchObject({
			method: "notify",
			payload: { message: "attached notification" },
		});
		expect(extensionUiRequests(second.outbound).at(-1)).toMatchObject({
			method: "notify",
			payload: { message: "attached notification" },
		});
		expect(extensionUiRequests(incapable.outbound)).toEqual([]);
	});

	it("drops pending notifications when the session closes", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.ui.notify("do not leak"));
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		cancelPendingExtensionUiRequests(state);
		const client = createClient("after-close");
		await attach(internals, client.client, state.activeSessionId, true);
		await waitForImmediate();

		expect(extensionUiRequests(client.outbound)).toEqual([]);
	});

	it("does not leak notifications across a session rebind", async () => {
		let startCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						startCount++;
						ctx.ui.notify(`startup ${startCount}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		const callbacks = {
			broadcast: (targetState: ActiveSessionState, message: DaemonOutbound) =>
				internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		};

		await bindActiveSessionState(state, callbacks);
		await bindActiveSessionState(state, callbacks);
		const client = createClient("after-rebind");
		await attach(internals, client.client, state.activeSessionId, true);
		await waitForImmediate();

		expect(extensionUiRequests(client.outbound).map((message) => message.payload.message)).toEqual(["startup 2"]);
	});

	it("bounds pending startup notifications and preserves retained order", async () => {
		const notificationCount = MAX_PENDING_EXTENSION_UI_NOTIFICATIONS + 3;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						for (let index = 0; index < notificationCount; index++) {
							ctx.ui.notify(`startup ${index}`);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		stubAttachResult(internals, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});

		const client = createClient("bounded");
		await attach(internals, client.client, state.activeSessionId, true);
		await waitForImmediate();
		const messages = extensionUiRequests(client.outbound).map((message) => message.payload.message);

		expect(messages).toHaveLength(MAX_PENDING_EXTENSION_UI_NOTIFICATIONS);
		expect(messages[0]).toBe("startup 3");
		expect(messages.at(-1)).toBe(`startup ${notificationCount - 1}`);
	});

	it("replays through worker subscription when the supervisor enables extension UI", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => ctx.ui.notify("worker startup"));
				},
			],
		});
		harnesses.push(harness);
		const state = createState(harness);
		const daemon = createDaemon(harness);
		const internals = daemon as unknown as DaemonInternals;
		internals.sessions.set(state.activeSessionId, state);
		await bindActiveSessionState(state, {
			broadcast: (targetState, message) => internals.broadcastToSession(targetState, message),
			shutdown: () => {},
		});
		const workerClient = createClient("supervisor-worker");

		await internals.handleWorkerCommand(workerClient.client, {
			type: "worker_subscribe",
			activeSessionId: state.activeSessionId,
			capabilities: ["extension_ui"],
			supportsExtensionUi: true,
		});
		await waitForImmediate();

		expect(extensionUiRequests(workerClient.outbound)).toEqual([
			expect.objectContaining({ method: "notify", payload: { message: "worker startup" } }),
		]);
	});

	it("enables worker extension UI only after a chunked public snapshot completes", async () => {
		let finishSnapshot: () => void = () => {};
		const snapshot = new Promise<void>((resolve) => {
			finishSnapshot = resolve;
		});
		const syncWorkerExtensionUi = vi.fn(async () => {});
		const attachResult = {
			activeSessionId: "active-1032",
			snapshot: { messages: [] },
		} as unknown as DaemonAttachResult;
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			attachClient: vi.fn(async () => ({
				result: attachResult,
				worker: {},
				transcript: {},
			})),
			createStreamedAttachResult: vi.fn(() => attachResult),
			streamSnapshot: vi.fn(() => snapshot),
			syncWorkerExtensionUi,
			write: vi.fn(() => true),
			log: vi.fn(),
		}) as unknown as SupervisorInternals;
		const client = createClient("public-client").client;
		client.capabilities.add("chunked_snapshot");

		await supervisor.handleCommand(client, {
			type: "attach",
			activeSessionId: "active-1032",
			capabilities: ["extension_ui", "chunked_snapshot"],
			supportsExtensionUi: true,
		});
		expect(syncWorkerExtensionUi).not.toHaveBeenCalled();

		finishSnapshot();
		await snapshot;
		await waitForImmediate();
		expect(syncWorkerExtensionUi).toHaveBeenCalledOnce();
		expect(syncWorkerExtensionUi).toHaveBeenCalledWith("active-1032");
	});
});

function createState(harness: Harness): ActiveSessionState {
	const runtime = {
		session: harness.session,
		cwd: harness.tempDir,
		metadata: { kind: "top-level", createdAt: Date.now() },
		diagnostics: [],
		setRuntimeEnvScope: vi.fn(),
		setSubagentRuntimeHost: vi.fn(),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
	return {
		activeSessionId: "active-1032",
		runtime,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "generation-1032",
		lastEventSequence: 0,
	};
}

function createDaemon(harness: Harness): AgentDaemon {
	return new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
		defaultSessionConfig: { agentDir: harness.tempDir, cwd: harness.tempDir },
		createRuntime: async () => {
			throw new Error("Unexpected runtime creation");
		},
	});
}

function stubAttachResult(internals: DaemonInternals, state: ActiveSessionState): void {
	internals.createAttachResult = vi.fn(async (client) => {
		return {
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: state.activeSessionId,
			snapshot: {},
			replay: { status: "complete", toSequence: state.lastEventSequence },
			lastEventSequence: state.lastEventSequence,
			client: { id: client.id, capabilities: [...client.capabilities] },
		} as unknown as DaemonAttachResult;
	});
}

function createClient(id: string): { client: DaemonSocketClient; outbound: DaemonOutbound[] } {
	const outbound: DaemonOutbound[] = [];
	const socket = {
		destroyed: false,
		write(data: string | Uint8Array) {
			outbound.push(JSON.parse(String(data)) as DaemonOutbound);
			return true;
		},
	} as unknown as Socket;
	return {
		client: {
			id,
			socket,
			attachedActiveSessionIds: new Set(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(),
			transport: "jsonl",
		},
		outbound,
	};
}

async function attach(
	internals: DaemonInternals,
	client: DaemonSocketClient,
	activeSessionId: string,
	supportsExtensionUi: boolean,
): Promise<void> {
	await internals.handleCommand(client, {
		type: "attach",
		activeSessionId,
		supportsExtensionUi,
		capabilities: supportsExtensionUi ? ["extension_ui"] : [],
	});
}

function extensionUiRequests(
	outbound: DaemonOutbound[],
): Array<Extract<DaemonOutbound, { type: "extension_ui_request" }>> {
	return outbound.filter(
		(message): message is Extract<DaemonOutbound, { type: "extension_ui_request" }> =>
			message.type === "extension_ui_request",
	);
}

function waitForImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
