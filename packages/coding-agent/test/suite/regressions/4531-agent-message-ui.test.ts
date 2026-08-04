import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
	isAgentSessionMessagePrompt,
} from "../../../src/core/agent-messages.js";
import type { KernelSentAgentMessage } from "../../../src/core/kernel/index.js";
import { AgentMessageComponent } from "../../../src/modes/interactive/components/agent-message.js";
import { buildConversationComponents } from "../../../src/modes/interactive/components/conversation-components.js";
import { IPythonCellComponent } from "../../../src/modes/interactive/components/ipython-cell.js";
import { formatQueuedMessagePreview, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

function createPayload(message: string): AgentSessionMessagePayload {
	return {
		id: "agentmsg_4531",
		source: AGENT_MESSAGE_SOURCE,
		message,
		deliveryMode: "auto",
		from: {
			activeSessionId: "planner-active",
			sessionId: "planner-session",
			sessionName: "Planner",
		},
		target: {
			activeSessionId: "worker-active",
			sessionId: "worker-session",
			sessionName: "Worker",
		},
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: AgentMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

type LateSentAgentMessageHost = {
	_recordLateIpythonSentAgentMessage: (toolCallId: string, message: KernelSentAgentMessage) => void;
	_agentEventQueue: Promise<void>;
	_lateIpythonSentAgentMessages: Map<string, KernelSentAgentMessage[]>;
	_restoreLateIpythonSentAgentMessages: () => void;
};

describe("ENG-4531 agent message UI", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records delivered agent messages as custom transcript entries while preserving provider input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const payload = createPayload("Review the benchmark notes.");
		const prompt = createAgentSessionMessagePrompt(payload);
		const message = createAgentSessionMessage(payload);
		let providerMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				providerMessages = [...context.messages];
				return fauxAssistantMessage("Reviewed.");
			},
		]);

		await harness.session.acceptAgentMessagePrompt(prompt, { customMessage: message });
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.messages[0]).toMatchObject({
			role: "custom",
			customType: "agent_message",
			display: true,
		});
		expect(getMessageText(providerMessages.at(-1))).toBe(prompt);
		expect(providerMessages.at(-1)?.role).toBe("user");
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "agent_message"),
		).toBe(true);
	});

	it("leaves text-only agent envelopes as user messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const prompt = createAgentSessionMessagePrompt(createPayload("Previously persisted message."));
		harness.setResponses([fauxAssistantMessage("Handled.")]);

		await harness.session.acceptAgentMessagePrompt(prompt);
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([prompt]);
		expect(harness.session.messages[0]?.role).toBe("user");
	});

	it("preserves structured messages passed through the normal prompt path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const payload = createPayload("Run the idle-session review.");
		const prompt = createAgentSessionMessagePrompt(payload);
		harness.setResponses([fauxAssistantMessage("Handled.")]);

		await harness.session.prompt(prompt, {
			expandPromptTemplates: false,
			customMessage: createAgentSessionMessage(payload),
		});
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.messages[0]).toMatchObject({
			role: "custom",
			customType: "agent_message",
			details: { id: "agentmsg_4531", message: "Run the idle-session review." },
		});
	});

	it("keeps queued agent messages structured and removable by message identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const payload = createPayload("Use shard seven.");
		const prompt = createAgentSessionMessagePrompt(payload);
		const message = createAgentSessionMessage(payload);

		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);

		expect(harness.session.getFollowUpMessagePreviews()).toEqual(["Agent message received: Use shard seven."]);
		const queued = harness.session.getSessionActionRecoverySnapshot().actions[0];
		expect(queued?.payload.kind === "turn" ? queued.payload.customMessage : undefined).toMatchObject({
			customType: "agent_message",
			details: { id: "agentmsg_4531", message: "Use shard seven." },
		});
		expect(harness.session.clearQueuedUserMessagesMatching(isAgentSessionMessagePrompt)).toEqual({
			steering: [],
			followUp: [prompt],
		});
	});

	it("does not add a second queue label to agent message previews", () => {
		expect(formatQueuedMessagePreview("Agent message received: Use shard seven.", "Follow-up")).toBe(
			"Agent message received: Use shard seven.",
		);
		expect(formatQueuedMessagePreview("Run the remaining checks.", "Steering")).toBe(
			"Steering: Run the remaining checks.",
		);
	});

	it("persists sent messages that arrive after their Python cell completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "ipython_4531",
			toolName: "ipython",
			content: [{ type: "text", text: "" }],
			details: { status: "ok" },
			isError: false,
			timestamp: Date.now(),
		};
		harness.session.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("ipython", { code: "background_send" }), { stopReason: "toolUse" }),
		);
		harness.session.sessionManager.appendMessage(toolResult);
		harness.session.agent.state.messages.push(toolResult);
		const lateMessage = {
			id: "agentmsg_late_4531",
			message: "Background review finished.",
			deliveryStatus: "delivered" as const,
			target: {
				activeSessionId: "worker-active",
				sessionId: "worker-session",
				sessionName: "Worker",
			},
		};
		const events: string[] = [];
		const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
		const host = harness.session as unknown as LateSentAgentMessageHost;

		host._recordLateIpythonSentAgentMessage(toolResult.toolCallId, lateMessage);
		await host._agentEventQueue;
		unsubscribe();

		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "ipython_sent_agent_message"),
		).toBe(true);
		expect(events).toContain("ipython_sent_agent_message");
		expect(
			harness.session
				.buildSessionContext()
				.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === toolResult.toolCallId,
				)?.details,
		).toMatchObject({ sentAgentMessages: [lateMessage] });

		toolResult.details = { status: "ok" };
		host._restoreLateIpythonSentAgentMessages();
		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });

		toolResult.details = { status: "ok" };
		host._lateIpythonSentAgentMessages = new Map();
		host._restoreLateIpythonSentAgentMessages();
		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });

		host._lateIpythonSentAgentMessages.set("ipython_other_branch", [
			{
				id: "agentmsg_other_branch",
				message: "Stale branch receipt.",
				deliveryStatus: "delivered",
				target: { activeSessionId: "other", sessionId: "other-session" },
			},
		]);
		host._restoreLateIpythonSentAgentMessages();
		expect(host._lateIpythonSentAgentMessages.has("ipython_other_branch")).toBe(false);
	});

	it("preserves the custom message when direct delivery races with active work", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Original turn complete."),
			fauxAssistantMessage("Agent message handled."),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("Start work.");
		await sawToolStart;
		const payload = createPayload("Queue behind the active turn.");
		const prompt = createAgentSessionMessagePrompt(payload);

		await harness.session.acceptAgentMessagePrompt(prompt, {
			customMessage: createAgentSessionMessage(payload),
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});

		const queued = harness.session.getSessionActionRecoverySnapshot().actions[0];
		expect(queued?.payload.kind === "turn" ? queued.payload.customMessage : undefined).toMatchObject({
			customType: "agent_message",
			details: { message: "Queue behind the active turn." },
		});
		releaseToolExecution?.();
		await promptPromise;
		await harness.session.agent.waitForIdle();
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "agent_message",
			),
		).toBe(true);
	});

	it("classifies a spawn task as an agent message component", () => {
		const spawnMessage: AgentSessionMessage = {
			role: "custom",
			customType: "agent_message",
			content: "[task from parent]\n\nReview shard seven.",
			display: true,
			details: {
				id: "spawn:sub-worker",
				message: "Review shard seven.",
				from: { sessionId: "parent-session", sessionName: "Planner" },
				fromRelationship: "parent",
			},
			timestamp: 123,
		};

		const components = buildConversationComponents([spawnMessage], {
			ui: { requestRender: () => {} } as unknown as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		});

		expect(components).toHaveLength(1);
		expect(components[0]).toBeInstanceOf(AgentMessageComponent);
		expect(render(components[0] as AgentMessageComponent)).toContain("Agent message received · parent");
	});

	it("uses compact rebuilt spacing for agent messages next to messages and tool cells", () => {
		const first = createAgentSessionMessage(createPayload("First notification."));
		const second = createAgentSessionMessage({ ...createPayload("Second notification."), id: "agentmsg_4531_2" });
		const toolCall = fauxAssistantMessage(fauxToolCall("ipython", { code: "print('ready')" }), {
			stopReason: "toolUse",
		});
		const options = {
			ui: { requestRender: () => {} } as unknown as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		};

		const adjacent = buildConversationComponents([first, second], options);
		expect(adjacent).toHaveLength(2);
		expect(adjacent[0]?.render(120)[0]).toBe("");
		expect(adjacent[1]?.render(120)[0]).not.toBe("");

		const toolThenMessage = buildConversationComponents([toolCall, second], options);
		expect(toolThenMessage.at(-1)?.render(120)[0]).not.toBe("");
		const messageThenTool = buildConversationComponents([first, toolCall], options);
		expect(messageThenTool.at(-1)?.render(120)[0]).not.toBe("");

		const textThenMessage = buildConversationComponents(
			[{ role: "user", content: "intervening prompt", timestamp: 123 }, second] as AgentMessage[],
			options,
		);
		expect(textThenMessage[1]?.render(120)[0]).toBe("");
	});

	it("suppresses leading space only between adjacent live agent messages", () => {
		const chatContainer = new Container();
		const mode = {
			chatContainer,
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: () => undefined,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const addMessage = (message: AgentMessage) =>
			Reflect.get(InteractiveMode.prototype, "addMessageToChat").call(mode, message);
		const first = createAgentSessionMessage(createPayload("First notification."));
		const second = createAgentSessionMessage({ ...createPayload("Second notification."), id: "agentmsg_4531_2" });

		addMessage(first);
		addMessage(second);
		expect(chatContainer.children[0]?.render(120)[0]).toBe("");
		expect(chatContainer.children[1]?.render(120)[0]).not.toBe("");

		const toolComponents = buildConversationComponents(
			[fauxAssistantMessage(fauxToolCall("ipython", { code: "print('ready')" }), { stopReason: "toolUse" })],
			{
				ui: { requestRender: () => {} } as unknown as TUI,
				cwd: "/tmp",
				toolOptions: {},
				getToolDefinition: () => undefined,
			},
		);
		const toolComponent = toolComponents.at(-1);
		if (!toolComponent) throw new Error("Missing tool component");
		chatContainer.addChild(toolComponent);
		addMessage(second);
		expect(chatContainer.children[3]?.render(120)[0]).not.toBe("");

		chatContainer.addChild(new Container());
		addMessage(second);
		expect(chatContainer.children[5]?.render(120)[0]).toBe("");
	});

	it("renders relationship-aware sender labels with identifier fallbacks", () => {
		const parent = createAgentSessionMessage({ ...createPayload("From root."), fromRelationship: "parent" });
		const sibling = createAgentSessionMessage({
			...createPayload("From peer."),
			from: { sessionId: "peer-session", sessionName: "Peer" },
			fromRelationship: "sibling",
		});
		const childById = createAgentSessionMessage({
			...createPayload("From child."),
			from: { sessionId: "child-session" },
			fromRelationship: "child",
		});
		const unknownRelationship = createAgentSessionMessage({
			...createPayload("Legacy sender."),
			from: { sessionId: "legacy-session" },
		});

		expect(render(new AgentMessageComponent(parent))).toContain("Agent message received · parent");
		expect(render(new AgentMessageComponent(sibling))).toContain("Agent message received · sibling:Peer");
		expect(render(new AgentMessageComponent(childById))).toContain("Agent message received · child:child-session");
		expect(render(new AgentMessageComponent(unknownRelationship))).toContain(
			"Agent message received · legacy-session",
		);
		const expanded = new AgentMessageComponent(sibling);
		expanded.setExpanded(true);
		expect(render(expanded)).toContain("Agent message received · sibling:Peer");
	});

	it("renders a compact subagent-style row and expands only the message body", () => {
		const body = `${"Inspect the benchmark results and compare every shard. ".repeat(4)}Final instruction.`;
		const component = new AgentMessageComponent(createAgentSessionMessage(createPayload(body)));
		const collapsed = render(component);

		expect(collapsed).toContain("◆ Agent message received · Planner");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("Final instruction.");
		expect(collapsed).not.toContain("Source: agent_message");
		expect(collapsed).not.toContain("Message id:");

		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded.replace(/\s+/g, " ")).toContain("Final instruction.");
		expect(
			expanded
				.split("\n")
				.slice(2)
				.filter(Boolean)
				.every((line) => line.startsWith("  ")),
		).toBe(true);
		expect(expanded).not.toContain("Source: agent_message");
		expect(expanded).not.toContain("To: Worker");
		expect(expanded).not.toContain("Message id:");
	});

	it("renders sent messages beneath collapsed Python cells", () => {
		const component = new IPythonCellComponent({
			code: 'await agent_message.send("worker-active", "Review shard seven.")',
			executionStarted: true,
			details: {
				status: "ok",
				sentAgentMessages: [
					{
						id: "agentmsg_4531",
						message: "Review shard seven.",
						deliveryStatus: "queued",
						receiverRole: "child",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
					{
						id: "agentmsg_4531_delivered",
						message: "Continue with shard eight.",
						deliveryStatus: "delivered",
						receiverRole: "parent",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
				],
			},
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("◆ Agent message queued to child:Worker · Review shard seven.");
		expect(rendered).toContain("◆ Agent message sent to parent · Continue with shard eight.");
		expect(rendered).not.toContain("Agent message received");
	});
});
