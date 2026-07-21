import { describe, expect, test, vi } from "vitest";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat from the persisted compaction summary without appending a duplicate", async () => {
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
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
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
				customInstructions?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
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
});
