import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	AgentDaemon,
	cancelPendingExtensionUiRequests,
	detachClientFromActiveSession,
	getChildActiveSessionStates,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../src/modes/daemon/daemon-protocol.js";

describe("daemon mode helpers", () => {
	it("finds only direct child active sessions", () => {
		const parent = makeState("parent");
		const child = makeState("child", "parent");
		const grandchild = makeState("grandchild", "child");
		const sibling = makeState("sibling");
		const selfLinked = makeState("self-linked", "self-linked");
		const sessions = new Map<string, ActiveSessionState>(
			[parent, child, grandchild, sibling, selfLinked].map((state) => [state.activeSessionId, state]),
		);

		expect(getChildActiveSessionStates(sessions, parent).map((state) => state.activeSessionId)).toEqual(["child"]);
	});

	it("cancels pending extension UI requests when the last client detaches", () => {
		const firstClient = makeClient("client-1", "active");
		const secondClient = makeClient("client-2", "active");
		const firstResolve = vi.fn();
		const secondResolve = vi.fn();
		const state = {
			...makeState("active"),
			clients: new Set<DaemonSocketClient>([firstClient, secondClient]),
			extensionUiRequests: new Map([
				["request-1", { resolve: firstResolve }],
				["request-2", { resolve: secondResolve }],
			]),
		};

		detachClientFromActiveSession(firstClient, state);

		expect(state.extensionUiRequests.size).toBe(2);
		expect(firstResolve).not.toHaveBeenCalled();
		expect(firstClient.attachedActiveSessionIds.has("active")).toBe(false);

		detachClientFromActiveSession(secondClient, state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(firstResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondClient.attachedActiveSessionIds.has("active")).toBe(false);
	});

	it("cancels pending extension UI requests directly", () => {
		const resolve = vi.fn();
		const state = {
			...makeState("active"),
			extensionUiRequests: new Map([["request-1", { resolve }]]),
		};

		cancelPendingExtensionUiRequests(state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(resolve).toHaveBeenCalledWith({ cancelled: true });
	});

	it("sends dialog extension UI requests only to UI-capable clients", () => {
		const lineClient = makeClient("line-client", "active", false);
		const uiClient = makeClient("ui-client", "active", true);
		const dialogRequest = {
			type: "extension_ui_request",
			activeSessionId: "active",
			id: "request-1",
			method: "confirm",
			payload: {},
		} as const;

		expect(shouldSendDaemonOutboundToClient(lineClient, dialogRequest)).toBe(false);
		expect(shouldSendDaemonOutboundToClient(uiClient, dialogRequest)).toBe(true);
		expect(
			shouldSendDaemonOutboundToClient(lineClient, {
				...dialogRequest,
				method: "notify",
			}),
		).toBe(true);
	});

	it("validates active sessions before reading a heartbeat", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: {
				agentDir: "/tmp/prime-agent-test-agent",
				cwd: "/tmp",
			},
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const handleCommand = (
			daemon as unknown as {
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			}
		).handleCommand.bind(daemon);

		await expect(
			handleCommand(makeClient("client-1", "missing"), {
				id: "command-1",
				type: "heartbeat_get",
				activeSessionId: "missing",
			}),
		).rejects.toThrow("Unknown active session: missing");
	});
});

function makeState(activeSessionId: string, parentActiveSessionId?: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		lastEventSequence: 0,
		runtime: {
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId,
			},
		},
	} as unknown as ActiveSessionState;
}

function makeClient(id: string, activeSessionId: string, supportsExtensionUi = false): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi,
		capabilities: new Set(supportsExtensionUi ? ["extension_ui"] : []),
	};
}
