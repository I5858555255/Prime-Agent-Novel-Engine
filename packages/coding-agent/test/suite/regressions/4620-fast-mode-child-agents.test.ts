import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.js";
import { startSideQuestion } from "../../../src/core/side-question.js";
import { createHarness } from "../harness.js";

const fastModel = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	models: [{ id: "gpt-5.4" }],
};

describe("ENG-4620 fast mode child agents", () => {
	it("passes fast mode to side questions", async () => {
		const harness = await createHarness(fastModel);
		try {
			harness.session.setServiceTier("priority");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("side answer");
				},
			]);

			const run = startSideQuestion(harness.session.agent, "question-1", "Check fast mode", () => {});
			await run.done;
		} finally {
			harness.cleanup();
		}
	});

	it("passes and persists fast mode for inline RLM children", async () => {
		const harness = await createHarness({ ...fastModel, persistSession: true });
		try {
			harness.session.setServiceTier("priority");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("child answer");
				},
			]);

			const result = await harness.session.runRlmChild("Check fast mode");
			expect(result.answer).toBe("child answer");
			expect(result.session_dir).not.toBeNull();
			const childSessions = await SessionManager.list(harness.tempDir, result.session_dir!);
			const childSession = SessionManager.open(childSessions[0]!.path, result.session_dir!);
			expect(childSession.buildSessionContext().serviceTier).toBe("priority");
		} finally {
			harness.cleanup();
		}
	});
});
