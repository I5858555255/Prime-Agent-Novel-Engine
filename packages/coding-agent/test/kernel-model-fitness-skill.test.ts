import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledModelFitnessSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "model-fitness");
	return {
		name: "model-fitness",
		importName: "model_fitness",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("model-fitness skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-model-fitness-skill-"));
		mkdirSync(join(tempDir, "harness"), { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("recommends and records outcomes through the candidate host projection", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			env: {
				RLM_HARNESS_STATE_DIR: join(tempDir, "harness"),
			},
			pythonSkills: [bundledModelFitnessSkill()],
			hostHandlers: {
				"model_fitness.candidates": async (payload) => {
					requests.push({ type: "model_fitness.candidates", payload });
					return {
						models: [
							{
								provider: "openrouter",
								id: "openai/gpt-5.6-terra",
								name: "OpenAI: GPT-5.6 Terra",
								selector: "openrouter/openai/gpt-5.6-terra",
								reasoning: true,
								supportedThinkingLevels: ["off", "low", "medium", "high"],
								input: ["text", "image"],
								contextWindow: 1_000_000,
								maxTokens: 128_000,
								cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
								featured: true,
								benchmarks: { intelligence: 54, coding: 76.7, agentic: 47.4 },
							},
							{
								provider: "openrouter",
								id: "anthropic/claude-fable-5",
								name: "Anthropic: Claude Fable 5",
								selector: "openrouter/anthropic/claude-fable-5",
								reasoning: true,
								supportedThinkingLevels: ["off", "low", "medium", "high"],
								input: ["text", "image"],
								contextWindow: 200_000,
								maxTokens: 64_000,
								cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
								benchmarks: { intelligence: 59.9, coding: 76.5, agentic: 52.8 },
							},
						],
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
recommendation = await model_fitness.recommend(
    "Implement a parser and add regression tests",
    task_family="code_write",
    requirements={"min_context_tokens": 100000},
)
if recommendation["recommended"] is None:
    print(json.dumps({"debug_recommendation": recommendation}, sort_keys=True))
else:
    recorded = await model_fitness.record_outcome(
        recommendation["recommended"]["selector"],
        "code_write",
        "validated_pass",
        score=1.0,
        task="Implement a parser",
    )
    explained = await model_fitness.explain(recommendation["recommended"]["selector"], task_family="code_write")
    print(json.dumps({
        "recommended": recommendation["recommended"],
        "alternatives": recommendation["alternatives"],
        "recorded": recorded["recorded"],
        "observations": explained["local_observations"],
    }, sort_keys=True))
`);

		if (result.status !== "ok") {
			throw new Error(
				`kernel execution failed: ${result.error?.evalue ?? result.stderr}\n${result.error?.traceback?.join("\n") ?? ""}`,
			);
		}
		expect(result.stderr).toBe("");
		const output = JSON.parse(result.stdout.trim());
		if (output.debug_recommendation) {
			throw new Error(`no recommendation: ${JSON.stringify(output.debug_recommendation)}`);
		}
		expect(output.recommended.selector).toBe("openrouter/openai/gpt-5.6-terra");
		expect(output.recommended.quality).toBeGreaterThan(0.6);
		expect(output.recommended.estimated_cost_usd).toBeGreaterThan(0);
		expect(output.alternatives[0].selector).toBe("openrouter/anthropic/claude-fable-5");
		expect(output.recorded).toBe(true);
		expect(output.observations[0]).toMatchObject({ verdict: "validated_pass", score: 1 });
		expect(requests.map((request) => request.type)).toEqual(["model_fitness.candidates", "model_fitness.candidates"]);
		expect(requests.every((request) => request.payload.type === "model_fitness.candidates")).toBe(true);
	});
});
