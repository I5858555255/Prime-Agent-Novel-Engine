import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	getRefinementHistory,
	loadHarnessState,
	type RefinementResult,
	saveHarnessState,
} from "../src/core/refinement/index.js";
import type { CustomEntry } from "../src/core/session-manager.js";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function makeTempDir(): string {
	tempDir = mkdtempSync(join(tmpdir(), "prime-agent-refinement-test-"));
	return tempDir;
}

describe("harness refinement", () => {
	it("applies create, update, and delete edits to editable harness state", () => {
		const state = loadHarnessState(makeTempDir());
		const first = applyRefinementProposal(
			state,
			{
				summary: "Create reusable validation memory and skill",
				rationale: "The same validation issue repeated.",
				expectedOutcome: "Future runs validate through the target environment.",
				edits: [
					{
						action: "create",
						kind: "memory",
						id: "target_env_validation",
						title: "Target environment validation",
						content: "Run checks through the target repository environment.",
						path: "validation",
					},
					{
						action: "create",
						kind: "skill",
						id: "native_check",
						title: "Native check",
						content: "Use documented project commands for validation.",
					},
				],
			},
			{ id: "refine_1" },
		);
		const second = applyRefinementProposal(
			state,
			{
				summary: "Tighten validation skill",
				rationale: "The first skill was too vague.",
				expectedOutcome: "The agent names the exact command.",
				edits: [
					{
						action: "update",
						kind: "skill",
						id: "native_check",
						title: "Native check",
						content: "Use `npm run check` for this repo after code changes.",
					},
					{
						action: "delete",
						kind: "memory",
						id: "target_env_validation",
					},
				],
			},
			{ id: "refine_2" },
		);

		expect(first.appliedEdits).toHaveLength(2);
		expect(second.appliedEdits.filter((edit) => edit.applied)).toHaveLength(2);
		expect(state.entries.memory.target_env_validation).toBeUndefined();
		expect(state.entries.skill.native_check.content).toContain("npm run check");
		expect(state.entries.skill.native_check.version).toBe(2);
		expect(state.refinements.map((event) => event.id)).toEqual(["refine_1", "refine_2"]);
	});

	it("persists harness state in the RLM session directory", () => {
		const dir = makeTempDir();
		const state = loadHarnessState(dir);
		applyRefinementProposal(
			state,
			{
				summary: "Add prompt note",
				rationale: "The note is useful.",
				expectedOutcome: "The agent remembers the note.",
				edits: [
					{
						action: "create",
						kind: "prompt",
						id: "focused_edits",
						title: "Focused edits",
						content: "Prefer small harness edits.",
					},
				],
			},
			{ id: "refine_1" },
		);

		const statePath = saveHarnessState(dir, state);
		const reloaded = loadHarnessState(dir);

		expect(statePath.endsWith("harness_state.json")).toBe(true);
		expect(reloaded.entries.prompt.focused_edits.content).toBe("Prefer small harness edits.");
	});

	it("extracts refinement history from custom session entries", () => {
		const result: RefinementResult = {
			id: "refine_1",
			summary: "Add skill",
			rationale: "Repeated failure.",
			expectedOutcome: "Better validation.",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		};
		const entries: CustomEntry[] = [
			{
				type: "custom",
				customType: "other",
				data: {},
				id: "custom_1",
				parentId: null,
				timestamp: new Date().toISOString(),
			},
			{
				type: "custom",
				customType: "prime-agent.refinement",
				data: result,
				id: "custom_2",
				parentId: "custom_1",
				timestamp: new Date().toISOString(),
			},
		];

		expect(getRefinementHistory(entries)).toEqual([result]);
	});

	it("rejects attempts to edit the base system prompt", () => {
		const state = loadHarnessState(makeTempDir());
		const result = applyRefinementProposal(
			state,
			{
				summary: "Bad edit",
				rationale: "Should not apply.",
				expectedOutcome: "No change.",
				edits: [
					{
						action: "update",
						kind: "prompt",
						id: "base_system_prompt",
						title: "Base system prompt",
						content: "Replace everything.",
					},
				],
			},
			{ id: "refine_1" },
		);

		expect(result.appliedEdits[0].applied).toBe(false);
		expect(result.appliedEdits[0].error).toContain("base system prompt");
		expect(state.entries.prompt.base_system_prompt).toBeUndefined();
	});
});
