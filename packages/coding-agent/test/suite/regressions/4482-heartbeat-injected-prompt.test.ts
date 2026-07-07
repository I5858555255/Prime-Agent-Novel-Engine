import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentCronJob } from "../../../src/core/cron-jobs.js";
import { createGoalContextMessage, type GoalState } from "../../../src/core/goals.js";
import { createHeartbeatPromptMessage, HEARTBEAT_PROMPT_CUSTOM_TYPE } from "../../../src/core/messages.js";
import {
	InjectedPromptMessageComponent,
	isInjectedPromptMessage,
} from "../../../src/modes/interactive/components/injected-prompt-message.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

type AddMessageToChatHost = {
	addMessageToChat(
		this: LegacyHeartbeatRenderMode,
		message: AgentMessage,
		options?: { populateHistory?: boolean },
	): void;
};

type LegacyHeartbeatRenderMode = {
	connectionState: { heartbeat: AgentCronJob };
	chatContainer: Container;
	toolOutputExpanded: boolean;
	editor: { addToHistory?: (text: string) => void };
	getMarkdownThemeWithSettings: () => MarkdownTheme;
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: InjectedPromptMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

function createHeartbeat(): AgentCronJob {
	return {
		id: "heartbeat-1",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp/project",
		prompt: "Check whether the long-running task needs another step.",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 2,
	};
}

describe("ENG-4482 heartbeat injected prompt UI", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records heartbeat prompts as custom transcript messages while keeping provider input as user content", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				providerMessages = [...context.messages];
				return fauxAssistantMessage("heartbeat handled");
			},
		]);

		await harness.session.promptHeartbeat(createHeartbeat());

		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.messages[0]).toMatchObject({
			role: "custom",
			customType: HEARTBEAT_PROMPT_CUSTOM_TYPE,
			display: true,
		});
		expect(getMessageText(harness.session.messages[0])).toBe(
			"Check whether the long-running task needs another step.",
		);
		expect(providerMessages.at(-1)).toMatchObject({ role: "user" });
		expect(getMessageText(providerMessages.at(-1))).toBe("Check whether the long-running task needs another step.");
	});

	it("renders heartbeat prompts as expandable injected prompt panels", () => {
		const component = new InjectedPromptMessageComponent(createHeartbeatPromptMessage(createHeartbeat()));
		const collapsed = render(component);

		expect(collapsed).toContain("♥");
		expect(collapsed).toContain("Heartbeat prompt");
		expect(collapsed).toContain("5m");
		expect(collapsed).not.toContain("every 5m");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("Check whether the long-running task needs another step.");

		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded).toContain("Heartbeat prompt");
		expect(expanded).toContain("Check whether the long-running task needs another step.");
	});

	it("renders legacy daemon heartbeat user messages as injected prompt panels", () => {
		const heartbeat = createHeartbeat();
		const timestamp = Date.parse(heartbeat.nextRunAt ?? heartbeat.createdAt);
		const chatContainer = new Container();
		const addToHistory = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as LegacyHeartbeatRenderMode;
		mode.connectionState = { heartbeat };
		mode.chatContainer = chatContainer;
		mode.toolOutputExpanded = false;
		mode.editor = { addToHistory };
		mode.getMarkdownThemeWithSettings = () => getMarkdownTheme();
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: heartbeat.prompt }],
			timestamp,
		};

		(InteractiveMode.prototype as unknown as AddMessageToChatHost).addMessageToChat.call(mode, message, {
			populateHistory: true,
		});

		const rendered = stripAnsi(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Heartbeat prompt");
		expect(rendered).toContain("5m");
		expect(rendered).not.toContain("every 5m");
		expect(rendered).not.toContain("Check whether the long-running task needs another step.");
		expect(addToHistory).not.toHaveBeenCalled();
	});

	it("renders goal continuation prompts as injected prompt panels", () => {
		const goal: GoalState = {
			active: true,
			status: "active",
			goalId: "goal-1",
			objective: "Finish the implementation plan",
			tokensUsed: 10,
			timeUsedSeconds: 20,
			continuationsUsed: 1,
		};
		const message = createGoalContextMessage(goal, "continuation");
		const component = new InjectedPromptMessageComponent(message);

		expect(message.display).toBe(true);
		expect(isInjectedPromptMessage(message)).toBe(true);
		expect(render(component)).toContain("Goal continuation");

		component.setExpanded(true);
		expect(render(component)).toContain("<goal_context>");
	});
});
