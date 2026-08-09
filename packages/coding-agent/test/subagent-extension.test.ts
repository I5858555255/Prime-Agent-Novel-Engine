import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type AgentConfig,
	buildAgentProcessArgs,
	parseAgentConfig,
} from "../examples/extensions/subagent/agent-config.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

function parseProfile(thinkingLine?: string): AgentConfig | undefined {
	const thinkingBlock = thinkingLine ? `${thinkingLine}\n` : "";
	const { frontmatter, body } = parseFrontmatter(
		`---\nname: reviewer\ndescription: Reviews changes\nmodel: test-model\ntools: bash,edit\n${thinkingBlock}---\n\nReview the delegated task.\n`,
	);
	return parseAgentConfig(frontmatter, body, "project", "/tmp/reviewer.md");
}

describe("subagent example extension profiles", () => {
	it("defers string thinking validation to the child model configuration", () => {
		expect(parseProfile('thinking: " high "')?.thinking).toBe("high");
		expect(parseProfile('thinking: "future-level"')?.thinking).toBe("future-level");
		expect(parseProfile()?.thinking).toBeUndefined();
	});

	it("rejects non-string or empty thinking values", () => {
		for (const thinkingLine of ["thinking: 42", "thinking: [high]", 'thinking: ""', 'thinking: "   "']) {
			expect(parseProfile(thinkingLine)).toBeUndefined();
		}
	});

	it("configures thinking for every bundled sample profile", () => {
		const expected = {
			scout: "low",
			planner: "high",
			reviewer: "high",
			worker: "medium",
		};
		for (const [name, thinking] of Object.entries(expected)) {
			const content = readFileSync(
				new URL(`../examples/extensions/subagent/agents/${name}.md`, import.meta.url),
				"utf8",
			);
			const { frontmatter, body } = parseFrontmatter(content);
			const agent = parseAgentConfig(frontmatter, body, "project", `${name}.md`);
			expect(agent?.thinking).toBe(thinking);
		}
	});

	it("passes profile thinking as a separate CLI argument", () => {
		const agent = parseProfile('thinking: "high"');
		if (!agent) throw new Error("Expected valid profile");
		expect(buildAgentProcessArgs(agent)).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"test-model",
			"--thinking",
			"high",
			"--tools",
			"bash,edit",
		]);
		expect(buildAgentProcessArgs({ ...agent, thinking: undefined })).not.toContain("--thinking");
	});
});
