import { describe, expect, it } from "vitest";
import {
	createAgentSessionMessagePrompt,
	createAgentSessionMessageReceipt,
	normalizeAgentSessionMessage,
	resolveAgentSessionMessageStreamingBehavior,
} from "../src/modes/daemon/agent-session-bus.js";

describe("agent session bus", () => {
	it("formats routed messages with sender and target context", () => {
		const prompt = createAgentSessionMessagePrompt({
			message: "Use the latest benchmark notes.",
			deliveryMode: "auto",
			from: {
				activeSessionId: "planner",
				sessionId: "session-planner",
				sessionName: "Planner",
				clientId: "client-1",
			},
			target: {
				activeSessionId: "worker",
				sessionId: "session-worker",
				sessionName: "Worker",
			},
		});

		expect(prompt).toBe(
			[
				"Agent-to-agent message received.",
				"From: Planner, active planner, session session-planner, client client-1",
				"To: Worker, active worker, session session-worker",
				"",
				"Use the latest benchmark notes.",
			].join("\n"),
		);

		expect(
			createAgentSessionMessagePrompt({
				message: "hello",
				deliveryMode: "auto",
				from: { clientId: "client-only" },
				target: {
					activeSessionId: "worker",
					sessionId: "session-worker",
				},
			}),
		).toContain("From: client client-only");
	});

	it("uses follow-up delivery by default only when the target is streaming", () => {
		expect(resolveAgentSessionMessageStreamingBehavior(false, "auto")).toBeUndefined();
		expect(resolveAgentSessionMessageStreamingBehavior(true, "auto")).toBe("followUp");
		expect(resolveAgentSessionMessageStreamingBehavior(true, "follow_up")).toBe("followUp");
		expect(resolveAgentSessionMessageStreamingBehavior(true, "steer")).toBe("steer");
	});

	it("normalizes messages and creates receipts", () => {
		const message = normalizeAgentSessionMessage("  hello from another session  ");
		const receipt = createAgentSessionMessageReceipt(
			{
				message,
				deliveryMode: "follow_up",
				target: {
					activeSessionId: "target",
					sessionId: "session-target",
				},
			},
			"2026-06-15T12:00:00.000Z",
		);

		expect(message).toBe("hello from another session");
		expect(receipt).toEqual({
			target: {
				activeSessionId: "target",
				sessionId: "session-target",
			},
			from: undefined,
			message: "hello from another session",
			deliveredAt: "2026-06-15T12:00:00.000Z",
			deliveryMode: "follow_up",
		});
		expect(() => normalizeAgentSessionMessage("  ")).toThrow("Agent session message cannot be empty");
	});
});
