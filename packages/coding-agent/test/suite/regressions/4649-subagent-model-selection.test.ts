import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness } from "../harness.js";

const provider = "faux-eng-4649";

describe("ENG-4649 subagent model selection", () => {
	it("lists only authenticated provider-qualified models in the prompt", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		try {
			const prompt = harness.session.agent.state.systemPrompt;
			expect(prompt).toContain(`\`${provider}/parent-model\``);
			expect(prompt).toContain(`\`${provider}/child-model\``);
			expect(prompt).not.toContain("`anthropic/claude-sonnet-4-5`");
			expect(prompt).toContain("do not choose a different model on your own");
		} finally {
			harness.cleanup();
		}
	});

	it("runs and retains a child on an explicitly selected model", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{ id: "parent-model", reasoning: true },
				{ id: "child-model", reasoning: false },
				{ id: "later-parent-model", reasoning: true },
			],
			persistSession: true,
		});
		try {
			harness.session.setThinkingLevel("high");
			const seenModels: string[] = [];
			harness.setResponses([
				(_context, _options, _state, model) => {
					seenModels.push(model.id);
					return fauxAssistantMessage("initial child answer");
				},
				(_context, _options, _state, model) => {
					seenModels.push(model.id);
					return fauxAssistantMessage("follow-up child answer");
				},
			]);

			const result = await harness.session.runRlmChild("inspect the API", {
				name: "api-reviewer",
				model: `${provider}/child-model`,
			});
			const childEntry = harness.session.listRlmSubagents().subagents[0];
			expect(childEntry?.status).toBe("completed");
			const child = harness.session.getRlmChildSession(childEntry!.rlm_child_id);
			expect(child?.model?.id).toBe("child-model");
			expect(child?.thinkingLevel).toBe("off");

			await harness.session.setModel(harness.getModel("later-parent-model")!);
			await child!.prompt("check the follow-up", { expandPromptTemplates: false, source: "extension" });
			await child!.agent.waitForIdle();

			expect(seenModels).toEqual(["child-model", "child-model"]);
			expect(child?.model?.id).toBe("child-model");
			expect(result.session_dir).not.toBeNull();
			const childSessions = await SessionManager.list(harness.tempDir, result.session_dir!);
			const persisted = SessionManager.open(childSessions[0]!.path, result.session_dir!);
			expect(persisted.buildSessionContext().model).toEqual({
				provider,
				modelId: "child-model",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("inherits the parent model when no override is supplied", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		try {
			let seenModel: string | undefined;
			harness.setResponses([
				(_context, _options, _state, model) => {
					seenModel = model.id;
					return fauxAssistantMessage("inherited child answer");
				},
			]);

			await harness.session.runRlmChild("inherit the model");
			expect(seenModel).toBe("parent-model");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects invalid or unavailable selectors before creating a child", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		try {
			await expect(harness.session.runRlmChild("bad type", { model: 42 })).rejects.toThrow(
				"rlm.run model must be a string",
			);
			await expect(harness.session.runRlmChild("missing provider", { model: "child-model" })).rejects.toThrow(
				'rlm.run model must use "provider/model" format',
			);
			await expect(
				harness.session.runRlmChild("unknown model", { model: `${provider}/missing-model` }),
			).rejects.toThrow(`RLM subagent model "${provider}/missing-model" was not found`);
			await expect(
				harness.session.runRlmChild("unauthenticated provider", {
					model: "anthropic/claude-sonnet-4-5",
				}),
			).rejects.toThrow("No API key for anthropic/claude-sonnet-4-5");

			const availability = vi.spyOn(harness.session.modelRegistry, "canUseModel").mockResolvedValue(false);
			await expect(
				harness.session.runRlmChild("disallowed model", { model: `${provider}/child-model` }),
			).rejects.toThrow(`Model "${provider}/child-model" is not available for the current Prime team.`);
			availability.mockRestore();

			expect(harness.session.listRlmSubagents().subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});
