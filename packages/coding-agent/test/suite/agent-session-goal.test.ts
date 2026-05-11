import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

describe("AgentSession goals", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("stops when the classifier marks the goal complete", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("I wrote the greeting."),
			fauxAssistantMessage('{"complete":true,"reason":"greeting is written"}'),
		]);

		await harness.session.prompt("/goal write a greeting");

		expect(getAssistantTexts(harness)).toEqual(["I wrote the greeting."]);
		expect(getMessageText(harness.session.messages[0])).toContain("write a greeting");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 0,
			lastReason: "greeting is written",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("injects a hidden continuation when the classifier marks the goal incomplete", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("I need another step."),
			fauxAssistantMessage('{"complete":false,"reason":"not done yet"}'),
			fauxAssistantMessage("The goal is done now."),
			fauxAssistantMessage('{"complete":true,"reason":"done"}'),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(getAssistantTexts(harness)).toEqual(["I need another step.", "The goal is done now."]);
		const hiddenContinuation = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "goal_continuation",
		);
		expect(hiddenContinuation).toMatchObject({
			role: "custom",
			display: false,
		});
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
			lastReason: "done",
		});
	});

	it("continues by default when the classifier output is malformed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("I stopped early."),
			fauxAssistantMessage("not json"),
			fauxAssistantMessage("Now it is done."),
			fauxAssistantMessage('{"complete":true,"reason":"done"}'),
		]);

		await harness.session.prompt("/goal complete despite classifier parse failure");

		expect(getAssistantTexts(harness)).toEqual(["I stopped early.", "Now it is done."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 1,
			lastReason: "done",
		});
	});

	it("stops at the configured continuation limit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("First stop."),
			fauxAssistantMessage('{"complete":false,"reason":"needs more"}'),
			fauxAssistantMessage("Second stop."),
		]);

		await harness.session.prompt("/goal --turns 1 keep working");

		expect(getAssistantTexts(harness)).toEqual(["First stop.", "Second stop."]);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "limit_reached",
			continuationsUsed: 1,
			lastReason: "Reached 1 continuation turn limit",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

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

	it("marks the goal as stopped on aborted runs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "aborted" })]);

		await harness.session.prompt("/goal do work");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "stopped",
			lastReason: "Aborted by user",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
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
