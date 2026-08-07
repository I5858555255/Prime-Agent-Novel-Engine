import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { emptyGoalState } from "../../../src/core/goals.js";
import type { AgentConnectionSnapshot, AgentConnectionState } from "../../../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";

function createConnectionState(messageCount: number): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/tmp/project",
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session-1",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: emptyGoalState(),
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
	};
}

function userMessage(index: number): Extract<AgentMessage, { role: "user" }> {
	return {
		role: "user",
		content: `message-${index}`,
		timestamp: index,
	};
}

describe("issue #774 session resync rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("limits a large resync transcript to the recent render window", async () => {
		const messages = Array.from({ length: 401 }, (_, index) => userMessage(index));
		const renderedMessages: AgentMessage[] = [];
		const chatContainer = new Container();
		const snapshot: AgentConnectionSnapshot = {
			state: createConnectionState(messages.length),
			messages,
		};
		const fakeThis = {
			activeBashComponent: undefined,
			sideQuestionBash: undefined,
			sideQuestionComponent: undefined,
			sideQuestionBashDiscarded: undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			toolOutputExpanded: false,
			chatContainer,
			editor: { addToHistory: vi.fn() },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			resetPendingToolState: vi.fn(),
			preloadToolDefinitions: vi.fn(async () => {}),
			settingsManager: { getShowImages: () => true },
			getCachedToolDefinition: () => undefined,
			getCurrentCwd: () => process.cwd(),
			getRetryAttempt: () => 0,
			ui: { requestRender: vi.fn() },
			addMessageToChat: (message: AgentMessage) => {
				renderedMessages.push(message);
			},
			applyConnectionStateSnapshot: vi.fn(),
			isBashRunning: () => false,
			replaceSubagentSummary: vi.fn(),
			getSessionContextFromConnectionSnapshot: (value: AgentConnectionSnapshot) => ({
				messages: value.messages,
				thinkingLevel: value.state.thinkingLevel,
				serviceTier: value.state.serviceTier,
				model: null,
			}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			refreshConnectionQueue: vi.fn(async () => {}),
			updateTerminalTitle: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			syncGoalTray: vi.fn(),
			syncWorkingLoader: vi.fn(),
			getGoalState: () => emptyGoalState(),
		} as unknown as InteractiveMode;
		Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);

		await (
			InteractiveMode.prototype as unknown as {
				renderResyncedSession(this: InteractiveMode, value: AgentConnectionSnapshot): Promise<void>;
			}
		).renderResyncedSession.call(fakeThis, snapshot);

		expect(renderedMessages).toHaveLength(400);
		expect(renderedMessages).toEqual(messages.slice(1));
	});
});
