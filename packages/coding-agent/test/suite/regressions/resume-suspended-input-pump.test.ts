import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

describe("suspended input pump resumes on programmatic admission", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("delivers a queued agent message at idle after an abort suspended the pump", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("agent mail handled")]);

		// An abort at idle leaves the input pump suspended.
		harness.session.requestAbort();
		await harness.session.agent.waitForIdle();

		await harness.session.queueAgentMessagePrompt("queued agent mail", "followUp");

		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("agent mail handled"));
		expect(getUserTexts(harness)).toContain("queued agent mail");
	});

	it("delivers items queued before an abort once a later programmatic admission arrives", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("backlog handled"), fauxAssistantMessage("second handled")]);

		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.queueAgentMessagePrompt("queued before abort", "followUp");
		harness.session.requestAbort();
		pause.release();
		await harness.session.agent.waitForIdle();

		// Without the fix, the backlog starves forever: only a user-typed prompt or
		// resumeQueuedWork() revives delivery.
		await harness.session.queueAgentMessagePrompt("queued after abort", "followUp");

		await vi.waitFor(() => {
			const users = getUserTexts(harness);
			expect(users).toContain("queued before abort");
			expect(users).toContain("queued after abort");
		});
	});
});
