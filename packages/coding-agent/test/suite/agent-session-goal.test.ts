import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

function assistantWithUsage(text: string, usage: Partial<Usage>): AssistantMessage {
	const base = fauxAssistantMessage(text);
	return {
		...base,
		usage: {
			...base.usage,
			...usage,
			cost: {
				...base.usage.cost,
				...usage.cost,
			},
		},
	};
}

function goalContextMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "goal_context",
	);
}

function visibleAssistantTexts(harness: Harness): string[] {
	return getAssistantTexts(harness).filter(Boolean);
}

function createWaitingTool(): {
	tool: AgentTool;
	release: () => void;
	waitForStart: (harness: Harness) => Promise<void>;
} {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				const abort = () => reject(new Error("aborted"));
				signal?.addEventListener("abort", abort, { once: true });
				toolRelease.then(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				});
			});
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
				terminate: true,
			};
		},
	};
	return {
		tool,
		release: () => releaseToolExecution?.(),
		waitForStart: (harness) =>
			new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "tool_execution_start" && event.toolName === "wait") {
						unsubscribe();
						resolve();
					}
				});
			}),
	};
}

describe("AgentSession goals", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps continuing until the model calls update_goal complete", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("I need another step."),
			fauxAssistantMessage("The work is complete."),
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(visibleAssistantTexts(harness)).toEqual([
			"I need another step.",
			"The work is complete.",
			"Goal complete.",
		]);
		expect(goalContextMessages(harness)).toHaveLength(3);
		expect(getMessageText(goalContextMessages(harness)[0])).toContain("<goal_context>");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 2,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not infer completion from an assistant claim without update_goal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Done."),
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal write a greeting");

		expect(visibleAssistantTexts(harness)).toEqual(["Done.", "Goal complete."]);
		expect(goalContextMessages(harness)).toHaveLength(2);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
		});
	});

	it("lets the model create a persistent goal with create_goal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("create_goal", { objective: "write a benchmark note" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Started the note."),
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("Create a goal to write a benchmark note.");

		expect(visibleAssistantTexts(harness)).toEqual(["Started the note.", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			objective: "write a benchmark note",
			continuationsUsed: 1,
		});
	});

	it("reloads goal state after tree navigation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("before goal")]);
		await harness.session.prompt("normal prompt");
		const beforeGoalEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!beforeGoalEntry) {
			throw new Error("expected assistant entry before goal");
		}

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);
		await harness.session.prompt("/goal finish the task");
		expect(harness.session.goalState.status).toBe("complete");

		await harness.session.navigateTree(beforeGoalEntry.id, { summarize: false });

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "idle",
		});
	});

	it("keeps active goals sticky across normal user prompts", async () => {
		const waiting = createWaitingTool();
		const harness = await createHarness({ tools: [waiting.tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("answered the side question"),
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("answer a side question", { streamingBehavior: "followUp" });
		waiting.release();
		await promptPromise;

		expect(visibleAssistantTexts(harness)).toEqual(["answered the side question", "Goal complete."]);
		expect(
			harness.session.messages.some((message) => getMessageText(message).includes("answer a side question")),
		).toBe(true);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
		});
	});

	it.each([
		{ command: "/goal clear", status: "idle" },
		{ command: "/goal pause", status: "paused" },
	])("removes queued goal context after $command while streaming", async ({ command, status }) => {
		const waiting = createWaitingTool();
		const harness = await createHarness({ tools: [waiting.tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("stale goal response"),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("start a blocking turn");
		await waitForStart;
		await harness.session.prompt("/goal stale goal");
		await harness.session.prompt(command);
		waiting.release();
		await promptPromise;

		expect(goalContextMessages(harness)).toHaveLength(0);
		expect(visibleAssistantTexts(harness)).toEqual([]);
		expect(harness.session.goalState.status).toBe(status);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("pauses an active goal with /goal pause", async () => {
		const waiting = createWaitingTool();
		const harness = await createHarness({ tools: [waiting.tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			lastReason: "Paused by user",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resumes a paused goal with /goal resume", async () => {
		const waiting = createWaitingTool();
		const harness = await createHarness({ tools: [waiting.tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 0,
		});
	});

	it("clears a goal with /goal clear without consuming a provider response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("/goal clear");

		expect(harness.session.messages).toEqual([]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not persist a goal when start preflight fails", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("/goal do task")).rejects.toThrow();

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "idle",
		});
		expect(harness.session.messages).toEqual([]);
	});

	it("marks an active goal budget_limited when token budget is reached", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			assistantWithUsage("Spent the budget.", { input: 6, output: 5, totalTokens: 11 }),
			fauxAssistantMessage("Wrapping up."),
		]);

		await harness.session.prompt("/goal --budget 10 do work");

		expect(visibleAssistantTexts(harness)).toEqual(["Spent the budget.", "Wrapping up."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
		});
		expect(harness.session.goalState.tokensUsed).toBeGreaterThanOrEqual(10);
	});

	it.each(["/goal --budget=1abc task", "/goal --budget 1.5 task", "/goal --budget 1e6 task"])(
		"rejects malformed goal budget %s",
		async (command) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("unused")]);

			await expect(harness.session.prompt(command)).rejects.toThrow("Goal token budget must be a positive integer.");

			expect(harness.session.goalState).toMatchObject({
				active: false,
				status: "idle",
			});
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("marks the goal as errored on terminal provider errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("/goal do work");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "error",
			lastError: "invalid_api_key",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps the goal active on aborted provider turns", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);

		await harness.session.prompt("/goal do work");

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("lets the user abort a goal turn, prompt in between, then resume the goal", async () => {
		const waiting = createWaitingTool();
		const harness = await createHarness({ tools: [waiting.tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.abort();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
		});

		harness.setResponses([
			fauxAssistantMessage("answered the interjection"),
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("answer this before continuing the goal");

		expect(visibleAssistantTexts(harness)).toEqual(["answered the interjection", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
		});
	});

	it("reports status without consuming a provider response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt("/goal status");

		expect(harness.session.messages).toEqual([]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
