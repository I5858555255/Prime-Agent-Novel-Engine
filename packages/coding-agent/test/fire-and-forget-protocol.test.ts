import { describe, expect, it } from "vitest";
import { createAgentSessionMessagePrompt, parseAgentSessionMessagePromptId } from "../src/core/agent-messages.js";

const endpoint = { activeSessionId: "active-child", sessionId: "child-id", sessionName: "worker" };

describe("fire-and-forget agent protocol", () => {
	it("labels nuclear-family delivery and keeps it parseable as an ordinary prompt", () => {
		const prompt = createAgentSessionMessagePrompt({
			id: "agentmsg_reply",
			source: "agent_message",
			message: "finished",
			from: { activeSessionId: "active-child", sessionId: "child-id", sessionName: "worker" },
			fromRelationship: "child",
			target: endpoint,
			deliveryMode: "auto",
		});
		expect(prompt).toContain("[from child:worker]");
		expect(parseAgentSessionMessagePromptId(prompt)).toBe("agentmsg_reply");
	});

	it("labels a parent without requiring a name", () => {
		const prompt = createAgentSessionMessagePrompt({
			id: "agentmsg_task",
			source: "agent_message",
			message: "continue",
			fromRelationship: "parent",
			target: endpoint,
			deliveryMode: "auto",
		});
		expect(prompt.startsWith("[from parent]\n")).toBe(true);
	});
});
