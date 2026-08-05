import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

function terminalMessage(messages: readonly unknown[]): AgentSessionMessage | undefined {
	return messages.find(
		(message): message is AgentSessionMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === AGENT_MESSAGE_CUSTOM_TYPE,
	);
}

describe("#617 subagent terminal agent messages", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it("delivers a child completion without a reply as an attributed agent message", async () => {
		const childSessionName = "terminal-worker";
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async (input) => {
					expect(input).toMatchObject({
						target: parent!.session.sessionId,
						deliveryMode: "follow_up",
						message: expect.stringContaining("completed without sending a reply"),
					});
					const message = createAgentSessionMessage({
						id: "agentmsg-terminal-completion",
						source: "agent_message",
						message: input.message,
						from: {
							activeSessionId: "child-active",
							sessionId: child!.session.sessionId,
							sessionName: childSessionName,
						},
						fromRelationship: "child",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
						deliveryMode: input.deliveryMode ?? "auto",
					});
					await parent!.session.acceptAgentMessagePrompt(message.content, { customMessage: message });
					return {
						id: message.details.id,
						source: "agent_message",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
						message: input.message,
						deliveryStatus: "delivered",
						deliveryMode: input.deliveryMode ?? "auto",
					};
				},
			},
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: childSessionName });

		await expect
			.poll(() => terminalMessage(parent!.session.messages))
			.toMatchObject({
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				details: {
					id: "agentmsg-terminal-completion",
					fromRelationship: "child",
					from: { sessionId: child.session.sessionId, sessionName: childSessionName },
				},
				content: expect.stringContaining(`[from child:${childSessionName}]`),
			});
		expect(parent.session.messages).not.toContainEqual(
			expect.objectContaining({ customType: "rlm_child_terminal_notice" }),
		);
		expect(terminalMessage(parent.session.messages)?.content).toContain(spawned.rlm_child_id);
	});
});
