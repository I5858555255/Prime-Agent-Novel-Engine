import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AgentConfig,
	buildAgentProcessArgs,
	parseAgentConfig,
	resolveAgentProcessConfig,
	resolveAgentThinking,
} from "../examples/extensions/subagent/agent-config.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

function parseProfile(thinkingLine?: string): AgentConfig | undefined {
	const thinkingBlock = thinkingLine ? `${thinkingLine}\n` : "";
	const { frontmatter, body } = parseFrontmatter(
		`---\nname: reviewer\ndescription: Reviews changes\nmodel: test-model\ntools: bash,edit\n${thinkingBlock}---\n\nReview the delegated task.\n`,
	);
	return parseAgentConfig(frontmatter, body, "project", "/tmp/reviewer.md");
}

function makeModel(reasoning: boolean, thinkingLevelMap?: Model<Api>["thinkingLevelMap"]): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://example.com",
		reasoning,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
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

	it("finds and clamps thinking from the selected model capabilities", () => {
		const agent = parseProfile('thinking: "xhigh"');
		if (!agent) throw new Error("Expected valid profile");

		const reasoning = resolveAgentThinking(agent, makeModel(true));
		expect(reasoning).toEqual({
			ok: true,
			requestedThinking: "xhigh",
			thinking: "high",
			availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
		});

		const nonReasoning = resolveAgentThinking({ ...agent, thinking: "high" }, makeModel(false));
		expect(nonReasoning).toEqual({
			ok: true,
			requestedThinking: "high",
			thinking: "off",
			availableThinkingLevels: ["off"],
		});
	});

	it("fails when model configuration exposes no thinking levels", () => {
		const agent = parseProfile('thinking: "high"');
		if (!agent) throw new Error("Expected valid profile");
		const resolution = resolveAgentThinking(
			agent,
			makeModel(true, {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
			}),
		);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("Expected empty capability failure");
		expect(resolution.error).toContain("No thinking levels are configured");
	});

	it("honors configured thinkingLevelMap support", () => {
		const agent = parseProfile('thinking: "high"');
		if (!agent) throw new Error("Expected valid profile");
		const resolution = resolveAgentThinking(
			agent,
			makeModel(true, { minimal: null, low: null, medium: null, high: null, xhigh: "extra", max: null }),
		);
		expect(resolution).toEqual({
			ok: true,
			requestedThinking: "high",
			thinking: "xhigh",
			availableThinkingLevels: ["off", "xhigh"],
		});
	});

	it("rejects unknown thinking names during model-aware resolution", () => {
		const agent = parseProfile('thinking: "future-level"');
		if (!agent) throw new Error("Expected valid profile");
		const resolution = resolveAgentThinking(agent, makeModel(true));
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("Expected invalid thinking resolution");
		expect(resolution.error).toContain('Invalid thinking level "future-level"');
	});

	it("resolves configured profile models before selecting effective thinking", () => {
		const agent = parseProfile('thinking: "high"');
		if (!agent) throw new Error("Expected valid profile");
		const selectedModel = { ...makeModel(true), provider: "anthropic", id: "claude-sonnet-4-5" };
		const resolution = resolveAgentProcessConfig(
			{ ...agent, model: "anthropic/claude-sonnet-4-5" },
			undefined,
			() => ({ model: selectedModel }),
		);
		expect(resolution).toMatchObject({
			ok: true,
			config: { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
			requestedThinking: "high",
		});
	});

	it("pins the active model when thinking is set without a profile model", () => {
		const agent = parseProfile('thinking: "xhigh"');
		if (!agent) throw new Error("Expected valid profile");
		const resolution = resolveAgentProcessConfig({ ...agent, model: undefined }, makeModel(true), () => {
			throw new Error("Profile model resolver should not be called");
		});
		expect(resolution).toEqual({
			ok: true,
			config: { model: "test-provider/test-model", thinking: "high" },
			requestedThinking: "xhigh",
		});
	});

	it("gives dedicated thinking precedence over a model selector suffix", () => {
		const agent = parseProfile('thinking: "low"');
		if (!agent) throw new Error("Expected valid profile");
		const selectedModel = { ...makeModel(true), provider: "anthropic", id: "claude-sonnet-4-5" };
		const explicit = resolveAgentProcessConfig(
			{ ...agent, model: "anthropic/claude-sonnet-4-5:high" },
			undefined,
			() => ({ model: selectedModel }),
		);
		expect(explicit).toMatchObject({
			ok: true,
			config: { model: "anthropic/claude-sonnet-4-5", thinking: "low" },
		});

		const suffixOnly = resolveAgentProcessConfig(
			{ ...agent, model: "anthropic/claude-sonnet-4-5:high", thinking: undefined },
			undefined,
			() => {
				throw new Error("Profile model resolver should not be called");
			},
		);
		expect(suffixOnly).toEqual({
			ok: true,
			config: { model: "anthropic/claude-sonnet-4-5:high" },
			requestedThinking: undefined,
		});
	});

	it("rejects model resolution warnings before capability selection", () => {
		const agent = parseProfile('thinking: "high"');
		if (!agent) throw new Error("Expected valid profile");
		const resolution = resolveAgentProcessConfig(
			{ ...agent, model: "anthropic/not-a-real-model" },
			undefined,
			() => ({ model: makeModel(true), warning: 'Unknown model "not-a-real-model".' }),
		);
		expect(resolution.ok).toBe(false);
		if (resolution.ok) throw new Error("Expected model resolution failure");
		expect(resolution.error).toContain("not-a-real-model");
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
		const resolution = resolveAgentThinking(agent, makeModel(true));
		if (!resolution.ok) throw new Error(resolution.error);
		expect(buildAgentProcessArgs(agent, { model: agent.model, thinking: resolution.thinking })).toEqual([
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
		expect(buildAgentProcessArgs({ ...agent, thinking: undefined }, { model: agent.model })).not.toContain(
			"--thinking",
		);
	});
});
