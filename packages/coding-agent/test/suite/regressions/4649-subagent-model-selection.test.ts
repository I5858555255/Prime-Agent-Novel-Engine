import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness } from "../harness.js";

const provider = "faux-eng-4649";

describe("ENG-4649 subagent model selection", () => {
	it("resolves a requested model from the authenticated catalog without advertising it", async () => {
		const harness = await createHarness({
			provider,
			models: Array.from({ length: 320 }, (_, index) => ({ id: `model-${index}` })),
		});
		try {
			const prompt = harness.session.agent.state.systemPrompt;
			expect(prompt).not.toContain(`${provider}/model-319`);
			harness.setResponses([fauxAssistantMessage("resolved child answer")]);

			await harness.session.runRlmChild("use the requested model", { model: "model 319" });

			const childEntry = harness.session.listRlmSubagents().subagents[0];
			const child = harness.session.getRlmChildSession(childEntry!.rlm_child_id);
			expect(child?.model?.id).toBe("model-319");
		} finally {
			harness.cleanup();
		}
	});

	it("reserves an explicit child name while model validation is pending", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }],
		});
		try {
			harness.setResponses([fauxAssistantMessage("first child answer")]);

			const first = harness.session.runRlmChild("first task", { name: "shared-reviewer" });
			await expect(harness.session.runRlmChild("second task", { name: "shared-reviewer" })).rejects.toThrow(
				'RLM subagent session name "shared-reviewer" is already in use',
			);
			await expect(first).resolves.toMatchObject({ answer: "first child answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("runs and retains a child on an explicitly selected model", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{ id: "parent-model", reasoning: true },
				{ id: "child-model", name: "Child Model", reasoning: false },
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
				model: "Child Model",
			});
			const childEntry = harness.session.listRlmSubagents().subagents[0];
			expect(childEntry?.status).toBe("completed");
			const child = harness.session.getRlmChildSession(childEntry!.rlm_child_id);
			expect(child?.model?.id).toBe("child-model");
			expect(child?.thinkingLevel).toBe("off");

			await harness.session.setModel(harness.getModel("later-parent-model")!);
			await child!.prompt("check the follow-up", { expandPromptTemplates: false, source: "extension" });
			await child!.agent.waitForIdle();

			expect(result.answer).toBe("initial child answer");
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
			await expect(
				harness.session.runRlmChild("unknown model", { model: `${provider}/missing-model` }),
			).rejects.toThrow(
				`RLM subagent model "${provider}/missing-model" was not found among authenticated, available models`,
			);
			await expect(
				harness.session.runRlmChild("unauthenticated provider", {
					model: "anthropic/claude-sonnet-4-5",
				}),
			).rejects.toThrow("was not found among authenticated, available models");

			const availability = vi
				.spyOn(harness.session.modelRegistry, "getAvailable")
				.mockReturnValue([harness.getModel("parent-model")!]);
			await expect(harness.session.runRlmChild("unavailable model", { model: "child-model" })).rejects.toThrow(
				'RLM subagent model "child-model" was not found among authenticated, available models',
			);
			availability.mockRestore();

			expect(harness.session.listRlmSubagents().subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});
