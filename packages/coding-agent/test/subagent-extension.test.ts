import { describe, expect, it } from "vitest";
import {
	type AgentConfig,
	buildAgentProcessArgs,
	parseAgentConfig,
} from "../examples/extensions/subagent/agent-config.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseProfile(thinkingLine?: string): AgentConfig | undefined {
	const thinkingBlock = thinkingLine ? `${thinkingLine}\n` : "";
	const { frontmatter, body } = parseFrontmatter(
		`---\nname: reviewer\ndescription: Reviews changes\nmodel: test-model\ntools: bash,edit\n${thinkingBlock}---\n\nReview the delegated task.\n`,
	);
	return parseAgentConfig(frontmatter, body, "project", "/tmp/reviewer.md");
}

describe("subagent example extension profiles", () => {
	it("loads every canonical thinking level and preserves omission", () => {
		for (const thinking of THINKING_LEVELS) {
			expect(parseProfile(`thinking: "${thinking}"`)?.thinking).toBe(thinking);
		}
		expect(parseProfile()?.thinking).toBeUndefined();
	});

	it("rejects profiles with invalid thinking values", () => {
		for (const thinkingLine of ['thinking: "ultra"', "thinking: 42", "thinking: [high]", 'thinking: "--tools"']) {
			expect(parseProfile(thinkingLine)).toBeUndefined();
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
