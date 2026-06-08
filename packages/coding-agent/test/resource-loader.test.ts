import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

function writeSkill(path: string, name: string, description = "A test skill"): void {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nSkill content.`);
}

function writeTheme(path: string, name: string, accent = "#00ffff"): void {
	const baseTheme = JSON.parse(
		readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
	) as { name: string; vars?: Record<string, string> };
	baseTheme.name = name;
	if (baseTheme.vars) {
		baseTheme.vars.accent = accent;
	}
	writeFileSync(path, JSON.stringify(baseTheme, null, 2));
}

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("reload", () => {
		it("initializes with empty resource results before reload", () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
		});

		it("discovers skills, prompts, and themes from agentDir", async () => {
			writeSkill(join(agentDir, "skills", "test-skill"), "test-skill");

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "test-prompt.md"), "---\ndescription: A test prompt\n---\nPrompt content.");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeTheme(join(themesDir, "test-theme.json"), "test-theme");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSkills().skills.some((skill) => skill.name === "test-skill")).toBe(true);
			expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "test-prompt")).toBe(true);
			expect(loader.getThemes().themes.some((theme) => theme.name === "test-theme")).toBe(true);
		});

		it("ignores extra markdown files in auto-discovered skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "pi-skills", "browser-tools");
			writeSkill(skillDir, "browser-tools", "Browser tools");
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((skill) => skill.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((diagnostic) => diagnostic.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});

		it("prefers project resources over user resources on name collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(cwd, ".prime", "agent", "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(cwd, ".prime", "agent", "skills", "collision-skill");
			writeSkill(userSkillDir, "collision-skill", "user");
			writeSkill(projectSkillDir, "collision-skill", "project");

			const userThemePath = join(agentDir, "themes", "collision.json");
			const projectThemePath = join(cwd, ".prime", "agent", "themes", "collision.json");
			mkdirSync(join(agentDir, "themes"), { recursive: true });
			mkdirSync(join(cwd, ".prime", "agent", "themes"), { recursive: true });
			writeTheme(userThemePath, "collision-theme", "#00ffff");
			writeTheme(projectThemePath, "collision-theme", "#ff00ff");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getPrompts().prompts.find((prompt) => prompt.name === "commit")?.filePath).toBe(
				projectPromptPath,
			);
			expect(loader.getSkills().skills.find((skill) => skill.name === "collision-skill")?.filePath).toBe(
				join(projectSkillDir, "SKILL.md"),
			);
			expect(loader.getThemes().themes.find((theme) => theme.name === "collision-theme")?.sourcePath).toBe(
				projectThemePath,
			);
		});

		it("honors overrides for auto-discovered resources", async () => {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
			settingsManager.setThemePaths(["-themes/skip.json"]);

			writeSkill(join(agentDir, "skills", "skip-skill"), "skip-skill", "Skip me");

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeTheme(join(themesDir, "skip.json"), "skip-theme");

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			expect(loader.getSkills().skills.some((skill) => skill.name === "skip-skill")).toBe(false);
			expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "skip")).toBe(false);
			expect(loader.getThemes().themes.some((theme) => theme.sourcePath?.endsWith("skip.json"))).toBe(false);
		});

		it("discovers AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path.includes("AGENTS.md"))).toBe(true);
		});

		it("skips AGENTS.md and CLAUDE.md discovery when noContextFiles is true", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
		});

		it("discovers system prompt files", async () => {
			const piDir = join(cwd, ".prime", "agent");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "You are a helpful assistant.");
			writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("You are a helpful assistant.");
			expect(loader.getAppendSystemPrompt()).toContain("Additional instructions.");
		});
	});

	describe("noSkills option", () => {
		it("skips skill discovery when noSkills is true", async () => {
			writeSkill(join(agentDir, "skills", "test-skill"), "test-skill");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			expect(loader.getSkills().skills).toEqual([]);
		});

		it("still loads additional skill paths when noSkills is true", async () => {
			const customSkillDir = join(tempDir, "custom-skills", "custom");
			writeSkill(customSkillDir, "custom", "Custom skill");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			expect(loader.getSkills().skills.some((skill) => skill.name === "custom")).toBe(true);
		});
	});

	describe("override functions", () => {
		it("applies skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
				kind: "markdown",
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			expect(loader.getSkills().skills).toEqual([injectedSkill]);
		});

		it("applies systemPromptOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPromptOverride: () => "Custom system prompt",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt");
		});
	});
});
