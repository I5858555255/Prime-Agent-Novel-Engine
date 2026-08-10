import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { goalContinuationIsStalled } from "../../../src/core/goals.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

/**
 * Regression for https://github.com/PrimeIntellect-ai/prime-agent/issues/986.
 *
 * A goal whose continuations repeatedly produce no tool calls (the model is
 * blocked on user approval, credentials, or an unanswered question) must pause
 * as waiting for user input instead of injecting identical goal contexts
 * forever, and must resume when the user actually replies.
 */

/**
 * Stand-in for the real ipython tool. `goal.*` cells are dispatched to the
 * session's goal host-request handler, mirroring the kernel comm bridge;
 * any other cell is a plain successful execution.
 */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId, params) => {
			const session = sessionRef.current;
			if (!session) {
				throw new Error("test session is not initialized");
			}
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				text = JSON.stringify(session.handleGoalHostRequest(code, {}));
			}
			return {
				content: [{ type: "text", text }],
				details: {},
			};
		},
	};
}

function goalContextMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "goal_context",
	);
}

function goalContextMessage(): AgentMessage {
	return {
		role: "custom",
		customType: "goal_context",
		content: "<goal_context>continue</goal_context>",
		display: true,
		timestamp: 0,
	};
}

describe("regression #986: goal continuation loop", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createGoalHarness(options: { initialGoal?: { objective: string } } = {}): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			initialGoal: options.initialGoal,
		});
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	it("pauses the goal as waiting for user input after repeated continuations without tool calls", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("Waiting for the sandbox key."),
			fauxAssistantMessage("State unchanged: still waiting for the sandbox key."),
			fauxAssistantMessage("State unchanged: still waiting for the sandbox key."),
		]);

		await harness.session.prompt("/goal run the evidence harness once the sandbox key arrives");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			waitingForUser: true,
			continuationsUsed: 2,
		});
		expect(harness.session.goalState.lastReason).toContain("Waiting for user input");
		// Initial context plus exactly two continuations; the loop must not run on.
		expect(goalContextMessages(harness)).toHaveLength(3);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resets the stall window when a continuation turn makes a tool call", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("Thinking about the first step."),
			fauxAssistantMessage("Still thinking."),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "print('working')" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Ran the script; waiting for review."),
			fauxAssistantMessage("State unchanged: waiting for review."),
			fauxAssistantMessage("State unchanged: waiting for review."),
			fauxAssistantMessage("State unchanged: waiting for review."),
		]);

		await harness.session.prompt("/goal run the script and wait for review");

		expect(harness.session.goalState).toMatchObject({
			status: "paused",
			waitingForUser: true,
		});
		// The tool-call turn resets the stall count, so three more toolless
		// continuations are needed before the goal pauses again.
		expect(goalContextMessages(harness)).toHaveLength(6);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resumes a stall-paused goal on the next user prompt and keeps continuing", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("Waiting for approval."),
			fauxAssistantMessage("Still waiting for approval."),
			fauxAssistantMessage("Still waiting for approval."),
		]);
		await harness.session.prompt("/goal ship the release after approval");
		expect(harness.session.goalState).toMatchObject({ status: "paused", waitingForUser: true });

		harness.appendResponses([
			fauxAssistantMessage("Approval received, shipping."),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Shipped."),
		]);

		await harness.session.prompt("Approved, go ahead.");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			lastReason: "Goal achieved",
		});
		// The user prompt reactivated continuations: one more goal context was
		// injected after the reply before the model completed the goal.
		expect(goalContextMessages(harness)).toHaveLength(4);
		const statusHistory = harness.eventsOfType("goal_update").map((event) => event.goal.status);
		expect(statusHistory.indexOf("paused")).toBeGreaterThanOrEqual(0);
		expect(statusHistory.lastIndexOf("active")).toBeGreaterThan(statusHistory.indexOf("paused"));
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not resume an explicitly paused goal on a user prompt", async () => {
		const harness = await createGoalHarness({ initialGoal: { objective: "hold until told otherwise" } });
		await harness.session.prompt("/goal pause");
		expect(harness.session.goalState).toMatchObject({ status: "paused" });
		expect(harness.session.goalState.waitingForUser).toBeUndefined();

		harness.setResponses([fauxAssistantMessage("Hello!")]);
		await harness.session.prompt("Hi there.");

		expect(harness.session.goalState).toMatchObject({ status: "paused" });
		expect(goalContextMessages(harness)).toHaveLength(0);
		expect(getAssistantTexts(harness)).toEqual(["Hello!"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("detects stalled continuation windows only when they are consecutive and trailing", () => {
		const text = () => fauxAssistantMessage("no progress");
		const toolCall = () =>
			fauxAssistantMessage(fauxToolCall("ipython", { code: "print('x')" }), { stopReason: "toolUse" });
		const userReply: AgentMessage = { role: "user", content: "new information", timestamp: 0 };

		const threeStalled = [goalContextMessage(), text(), goalContextMessage(), text(), goalContextMessage(), text()];
		expect(goalContinuationIsStalled(threeStalled)).toBe(true);

		const twoStalled = threeStalled.slice(2);
		expect(goalContinuationIsStalled(twoStalled)).toBe(false);

		const userInLastWindow = [...threeStalled, userReply];
		expect(goalContinuationIsStalled(userInLastWindow)).toBe(false);

		const toolCallInMiddleWindow = [
			goalContextMessage(),
			text(),
			goalContextMessage(),
			toolCall(),
			goalContextMessage(),
			text(),
		];
		expect(goalContinuationIsStalled(toolCallInMiddleWindow)).toBe(false);
	});
});
