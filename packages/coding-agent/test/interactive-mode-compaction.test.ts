import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode compaction events", () => {
	test("rebuilds successful compaction once and keeps skipped warnings durable", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			updateConnectionStateFromEvent: vi.fn(),
			activityTracker: new AgentActivityTracker(),
			updateWorkingLoaderMessage: vi.fn(),
			autoCompactionLoader: undefined,
			retryLoader: undefined,
			syncWorkingLoader: vi.fn(),
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn().mockResolvedValue(undefined),
			refreshConnectionContextUsage: vi.fn().mockResolvedValue(undefined),
			showError: vi.fn(),
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
				errorSeverity?: "warning" | "error";
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: { tokensBefore: 123, summary: "summary" },
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledOnce();
		expect(fakeThis.chatContainer.clear).not.toHaveBeenCalled();
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Session is too short to compact — try again once it grows",
			errorSeverity: "warning",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledWith("Session is too short to compact — try again once it grows");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("orders the persisted compaction summary at its chronological boundary", () => {
		const retained = { role: "user", content: [], timestamp: 1 } as AgentMessage;
		const summary = {
			role: "compactionSummary",
			summary: "summary",
			tokensBefore: 123,
			timestamp: 2,
		} as AgentMessage;
		const later = { role: "user", content: [], timestamp: 3 } as AgentMessage;
		const order = Reflect.get(InteractiveMode.prototype, "orderMessagesForTranscript") as (
			this: InteractiveMode,
			messages: AgentMessage[],
		) => AgentMessage[];

		expect(order.call({} as InteractiveMode, [summary, retained, later])).toEqual([retained, summary, later]);
	});

	test("separates every user-like transcript row from preceding output", () => {
		const previous = {};
		const component = {};
		const addChild = vi.fn();
		const fakeThis = { chatContainer: { children: [previous], addChild } };
		const addUserLike = Reflect.get(InteractiveMode.prototype, "addUserLikeMessageToChat") as (
			this: typeof fakeThis,
			component: object,
		) => void;

		addUserLike.call(fakeThis, component);

		expect(addChild).toHaveBeenCalledTimes(2);
		expect(addChild).toHaveBeenLastCalledWith(component);
	});

	test("ignores a context-usage refresh superseded by compaction", async () => {
		let resolveStats!: (stats: { contextUsage: { tokens: number; contextWindow: number; percent: number } }) => void;
		const stats = new Promise<{ contextUsage: { tokens: number; contextWindow: number; percent: number } }>(
			(resolve) => {
				resolveStats = resolve;
			},
		);
		const connection = { getSessionStats: vi.fn(() => stats) };
		const patchConnectionState = vi.fn();
		const fakeThis = {
			contextUsageRefreshId: 0,
			agentConnection: connection,
			connectionState: { sessionId: "session" },
			activityTracker: { getStatus: () => ({ tokens: 0 }) },
			contextUsageTokenBaseline: 0,
			patchConnectionState,
		};
		const refresh = Reflect.get(InteractiveMode.prototype, "refreshConnectionContextUsage") as (
			this: typeof fakeThis,
		) => Promise<void>;
		const pending = refresh.call(fakeThis);
		fakeThis.contextUsageRefreshId++;
		resolveStats({ contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } });

		await pending;

		expect(patchConnectionState).not.toHaveBeenCalled();
	});
});
