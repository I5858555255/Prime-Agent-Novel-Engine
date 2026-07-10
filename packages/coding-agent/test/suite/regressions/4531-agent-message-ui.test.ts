import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
	isAgentSessionMessagePrompt,
} from "../../../src/core/agent-messages.js";
import { AgentMessageComponent } from "../../../src/modes/interactive/components/agent-message.js";
import { IPythonCellComponent } from "../../../src/modes/interactive/components/ipython-cell.js";
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

	it("keeps queued agent messages structured and removable by message identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const payload = createPayload("Use shard seven.");
		const prompt = createAgentSessionMessagePrompt(payload);
		const message = createAgentSessionMessage(payload);

		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);

		expect(harness.session.getFollowUpMessagePreviews()).toEqual(["Agent message received: Use shard seven."]);
		expect(harness.session.getFollowUpQueueSnapshots()[0]?.customMessage).toMatchObject({
			customType: "agent_message",
			details: { id: "agentmsg_4531", message: "Use shard seven." },
		});
		expect(harness.session.clearQueuedUserMessagesMatching(isAgentSessionMessagePrompt)).toEqual({
			steering: [],
			followUp: [prompt],
		});
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

		expect(harness.session.getFollowUpQueueSnapshots()[0]?.customMessage).toMatchObject({
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
		expect(rendered).toContain("◆ Agent message queued · Worker · Review shard seven.");
		expect(rendered).toContain("◆ Agent message sent · Worker · Continue with shard eight.");
		expect(rendered).not.toContain("Agent message received");
	});
});
