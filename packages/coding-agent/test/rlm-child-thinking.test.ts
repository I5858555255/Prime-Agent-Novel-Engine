import { fauxAssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { normalizeRequestedRlmSubagentThinkingLevel } from "../src/core/rlm-runtime.js";
import { createHarness } from "./suite/harness.js";

const provider = "faux-rlm-child-thinking";

type SeenRequest = { model: string; reasoning: string | undefined };

function getReasoning(options: SimpleStreamOptions | undefined): string | undefined {
	return options?.reasoning;
}

describe("native RLM child thinking", () => {
	it("normalizes supported levels, trims whitespace, and rejects invalid values", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(normalizeRequestedRlmSubagentThinkingLevel(level)).toBe(level);
		}
		expect(normalizeRequestedRlmSubagentThinkingLevel(undefined)).toBeUndefined();
		expect(normalizeRequestedRlmSubagentThinkingLevel("  high  ")).toBe("high");
		expect(() => normalizeRequestedRlmSubagentThinkingLevel(null)).toThrow("rlm.run thinking must be a string");
		expect(() => normalizeRequestedRlmSubagentThinkingLevel(42)).toThrow("rlm.run thinking must be a string");
		expect(() => normalizeRequestedRlmSubagentThinkingLevel(" HIGH ")).toThrow(
			"rlm.run thinking must be one of: off, minimal, low, medium, high, xhigh, max",
		);
		expect(() => normalizeRequestedRlmSubagentThinkingLevel("turbo")).toThrow(
			"rlm.run thinking must be one of: off, minimal, low, medium, high, xhigh, max",
		);
	});

	it("inherits the parent level and passes the effective level to the child provider", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{ id: "parent-model", reasoning: true },
				{ id: "child-model", reasoning: true },
			],
		});
		try {
			harness.session.setThinkingLevel("high");
			const seenRequests: SeenRequest[] = [];
			harness.setResponses([
				(_context, options, _state, model) => {
					seenRequests.push({
						model: model.id,
						reasoning: getReasoning(options as SimpleStreamOptions | undefined),
					});
					return fauxAssistantMessage("inherited thinking child answer");
				},
			]);

			const result = await harness.session.runRlmChild("inherit the parent thinking level", {
				model: `${provider}/child-model`,
			});
			await vi.waitFor(async () => {
				expect((await harness.session.listRlmSubagents()).subagents[0]?.status).toBe("completed");
			});
			const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
			const child = childEntry && harness.session.getRlmChildSession(childEntry.rlm_child_id);
			expect(child?.thinkingLevel).toBe("high");
			expect(seenRequests).toContainEqual({ model: "child-model", reasoning: "high" });
			expect(result.model).toBe(`${provider}/child-model`);
		} finally {
			harness.cleanup();
		}
	});

	it("uses an explicit level independently and clamps it to the child model", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{ id: "parent-model", reasoning: true },
				{ id: "child-model", reasoning: true },
			],
		});
		try {
			harness.session.setThinkingLevel("low");
			const seenRequests: SeenRequest[] = [];
			harness.setResponses([
				(_context, options, _state, model) => {
					seenRequests.push({
						model: model.id,
						reasoning: getReasoning(options as SimpleStreamOptions | undefined),
					});
					return fauxAssistantMessage("explicit thinking child answer");
				},
			]);

			const result = await harness.session.runRlmChild("use an explicit thinking level", {
				model: `${provider}/child-model`,
				thinking: "max",
			});
			await vi.waitFor(async () => {
				expect((await harness.session.listRlmSubagents()).subagents[0]?.status).toBe("completed");
			});
			const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
			const child = childEntry && harness.session.getRlmChildSession(childEntry.rlm_child_id);
			expect(child?.thinkingLevel).toBe("high");
			expect(seenRequests).toContainEqual({ model: "child-model", reasoning: "high" });
			expect(result.model).toBe(`${provider}/child-model`);
		} finally {
			harness.cleanup();
		}
	});
});
