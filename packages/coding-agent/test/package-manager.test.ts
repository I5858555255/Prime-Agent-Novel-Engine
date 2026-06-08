import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, type ResolvedResource } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { shouldUseWindowsShell } from "../src/utils/child-process.js";

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

function isEnabled(resource: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") {
	const normalizedPath = normalizeForMatch(resource.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && resource.enabled
		: normalizedPath.includes(normalizedMatch) && resource.enabled;
}

function isDisabled(resource: ResolvedResource, pathMatch: string, matchFn: "endsWith" | "includes" = "endsWith") {
	const normalizedPath = normalizeForMatch(resource.path);
	const normalizedMatch = normalizeForMatch(pathMatch);
	return matchFn === "endsWith"
		? normalizedPath.endsWith(normalizedMatch) && !resource.enabled
		: normalizedPath.includes(normalizedMatch) && !resource.enabled;
}

type PackageManagerInternals = {
	parseSource(source: string): { type: string; path?: string; host?: string; ref?: string; pinned?: boolean };
	getPackageIdentity(source: string): string;
};

describe("DefaultPackageManager", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let previousOfflineEnv: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		tempDir = join(tmpdir(), `pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (previousOfflineEnv === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = previousOfflineEnv;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("resolve", () => {
		it("returns only supported resource groups", async () => {
			const result = await packageManager.resolve();
			expect(Object.keys(result).sort()).toEqual(["prompts", "skills", "themes"]);
			expect(result.prompts).toEqual([]);
			expect(result.themes).toEqual([]);
			expect(result.skills.every((r) => r.metadata.source === "auto" && r.metadata.origin === "top-level")).toBe(
				true,
			);
		});

		it("resolves skill paths from settings", async () => {
			const skillDir = join(agentDir, "skills", "my-skill");
			mkdirSync(skillDir, { recursive: true });
			const skillFile = join(skillDir, "SKILL.md");
			writeFileSync(skillFile, "---\nname: test-skill\ndescription: A test skill\n---\nContent");

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("auto-discovers root markdown skills from agent skill dirs", async () => {
			const skillFile = join(agentDir, "skills", "single-file.md");
			mkdirSync(join(agentDir, "skills"), { recursive: true });
			writeFileSync(skillFile, "---\nname: single-file\ndescription: A root markdown skill\n---\nContent");

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path === skillFile && r.enabled)).toBe(true);
		});

		it("resolves project resource paths relative to .prime/agent", async () => {
			const promptDir = join(tempDir, ".prime", "agent", "prompts");
			mkdirSync(promptDir, { recursive: true });
			const promptPath = join(promptDir, "project.md");
			writeFileSync(promptPath, "Project prompt");

			settingsManager.setProjectPromptTemplatePaths(["prompts/project.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => r.path === promptPath && r.enabled)).toBe(true);
		});

		it("dedupes symlinked user and project resources", async () => {
			const previousHome = process.env.HOME;
			process.env.HOME = tempDir;

			try {
				const sharedDir = join(tempDir, "shared-resources");
				const sharedSkillsDir = join(sharedDir, "skills");
				const sharedPromptsDir = join(sharedDir, "prompts");
				const sharedThemesDir = join(sharedDir, "themes");
				mkdirSync(sharedSkillsDir, { recursive: true });
				mkdirSync(sharedPromptsDir, { recursive: true });
				mkdirSync(sharedThemesDir, { recursive: true });

				mkdirSync(join(sharedSkillsDir, "shared-skill"), { recursive: true });
				writeFileSync(
					join(sharedSkillsDir, "shared-skill", "SKILL.md"),
					"---\nname: shared-skill\ndescription: Shared skill\n---\nContent",
				);
				writeFileSync(join(sharedPromptsDir, "shared.md"), "Shared prompt");
				writeFileSync(join(sharedThemesDir, "shared.json"), JSON.stringify({ name: "shared-theme" }));

				mkdirSync(join(tempDir, ".prime", "agent"), { recursive: true });
				symlinkSync(sharedSkillsDir, join(agentDir, "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(agentDir, "prompts"), "dir");
				symlinkSync(sharedThemesDir, join(agentDir, "themes"), "dir");
				symlinkSync(sharedSkillsDir, join(tempDir, ".prime", "agent", "skills"), "dir");
				symlinkSync(sharedPromptsDir, join(tempDir, ".prime", "agent", "prompts"), "dir");
				symlinkSync(sharedThemesDir, join(tempDir, ".prime", "agent", "themes"), "dir");

				const result = await packageManager.resolve();

				expect({
					skills: result.skills.length,
					prompts: result.prompts.length,
					themes: result.themes.length,
				}).toEqual({ skills: 1, prompts: 1, themes: 1 });
				expect(result.skills[0].metadata.scope).toBe("project");
				expect(result.prompts[0].metadata.scope).toBe("project");
				expect(result.themes[0].metadata.scope).toBe("project");
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});
	});

	describe(".agents/skills auto-discovery", () => {
		it("scans .agents/skills from cwd up to git repo root", async () => {
			const repoRoot = join(tempDir, "repo");
			const nestedCwd = join(repoRoot, "packages", "feature");
			mkdirSync(nestedCwd, { recursive: true });
			mkdirSync(join(repoRoot, ".git"), { recursive: true });

			const aboveRepoSkill = join(tempDir, ".agents", "skills", "above-repo", "SKILL.md");
			mkdirSync(join(tempDir, ".agents", "skills", "above-repo"), { recursive: true });
			writeFileSync(aboveRepoSkill, "---\nname: above-repo\ndescription: above\n---\n");

			const repoRootSkill = join(repoRoot, ".agents", "skills", "repo-root", "SKILL.md");
			mkdirSync(join(repoRoot, ".agents", "skills", "repo-root"), { recursive: true });
			writeFileSync(repoRootSkill, "---\nname: repo-root\ndescription: repo\n---\n");

			const nestedSkill = join(repoRoot, "packages", ".agents", "skills", "nested", "SKILL.md");
			mkdirSync(join(repoRoot, "packages", ".agents", "skills", "nested"), { recursive: true });
			writeFileSync(nestedSkill, "---\nname: nested\ndescription: nested\n---\n");

			const pm = new DefaultPackageManager({ cwd: nestedCwd, agentDir, settingsManager });

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === repoRootSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path === aboveRepoSkill)).toBe(false);
		});

		it("ignores root markdown files in .agents/skills", async () => {
			const agentsSkillsDir = join(tempDir, ".agents", "skills");
			mkdirSync(join(agentsSkillsDir, "nested-skill"), { recursive: true });
			const rootSkill = join(agentsSkillsDir, "root-file.md");
			const nestedSkill = join(agentsSkillsDir, "nested-skill", "SKILL.md");
			writeFileSync(rootSkill, "---\nname: root-file\ndescription: Root markdown file\n---\n");
			writeFileSync(nestedSkill, "---\nname: nested-skill\ndescription: Nested skill\n---\n");

			const pm = new DefaultPackageManager({
				cwd: join(tempDir, "work"),
				agentDir,
				settingsManager,
			});
			mkdirSync(join(tempDir, "work"), { recursive: true });

			const result = await pm.resolve();
			expect(result.skills.some((r) => r.path === rootSkill)).toBe(false);
			expect(result.skills.some((r) => r.path === nestedSkill && r.enabled)).toBe(true);
		});
	});

	describe("ignore files", () => {
		it("respects .gitignore in skill directories", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, ".gitignore"), "venv\n__pycache__\n");

			const goodSkillDir = join(skillsDir, "good-skill");
			mkdirSync(goodSkillDir, { recursive: true });
			writeFileSync(join(goodSkillDir, "SKILL.md"), "---\nname: good-skill\ndescription: Good\n---\nContent");

			const ignoredSkillDir = join(skillsDir, "venv", "bad-skill");
			mkdirSync(ignoredSkillDir, { recursive: true });
			writeFileSync(join(ignoredSkillDir, "SKILL.md"), "---\nname: bad-skill\ndescription: Bad\n---\nContent");

			settingsManager.setSkillPaths(["skills"]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => r.path.includes("good-skill") && r.enabled)).toBe(true);
			expect(result.skills.some((r) => r.path.includes("venv") && r.enabled)).toBe(false);
		});
	});

	describe("pattern filtering in top-level arrays", () => {
		it("filters themes with glob patterns", async () => {
			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "dark.json"), "{}");
			writeFileSync(join(themesDir, "light.json"), "{}");
			writeFileSync(join(themesDir, "funky.json"), "{}");

			settingsManager.setThemePaths(["themes", "!funky.json"]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isEnabled(r, "dark.json"))).toBe(true);
			expect(result.themes.some((r) => isEnabled(r, "light.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "funky.json"))).toBe(true);
		});

		it("filters prompts with exclusion patterns", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "review.md"), "Review code");
			writeFileSync(join(promptsDir, "explain.md"), "Explain code");

			settingsManager.setPromptTemplatePaths(["prompts", "!explain.md"]);

			const result = await packageManager.resolve();
			expect(result.prompts.some((r) => isEnabled(r, "review.md"))).toBe(true);
			expect(result.prompts.some((r) => isDisabled(r, "explain.md"))).toBe(true);
		});

		it("supports force-include patterns after exclusion", async () => {
			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "a.json"), "{}");
			writeFileSync(join(themesDir, "b.json"), "{}");

			settingsManager.setThemePaths(["themes", "!themes/b.json", "+themes/b.json"]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isEnabled(r, "a.json"))).toBe(true);
			expect(result.themes.some((r) => isEnabled(r, "b.json"))).toBe(true);
		});
	});

	describe("package manifests and filters", () => {
		it("loads skills, prompts, and themes from package manifests", async () => {
			const pkgDir = join(tempDir, "manifest-pkg");
			mkdirSync(join(pkgDir, "skills/good-skill"), { recursive: true });
			mkdirSync(join(pkgDir, "prompts"), { recursive: true });
			mkdirSync(join(pkgDir, "themes"), { recursive: true });
			writeFileSync(
				join(pkgDir, "skills/good-skill", "SKILL.md"),
				"---\nname: good-skill\ndescription: Good\n---\nContent",
			);
			writeFileSync(join(pkgDir, "prompts", "review.md"), "Review");
			writeFileSync(join(pkgDir, "themes", "dark.json"), "{}");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "manifest-pkg",
					pi: {
						skills: ["skills"],
						prompts: ["prompts"],
						themes: ["themes"],
					},
				}),
			);

			settingsManager.setPackages([pkgDir]);

			const result = await packageManager.resolve();
			expect(result.skills.some((r) => isEnabled(r, "good-skill", "includes"))).toBe(true);
			expect(result.prompts.some((r) => isEnabled(r, "review.md"))).toBe(true);
			expect(result.themes.some((r) => isEnabled(r, "dark.json"))).toBe(true);
		});

		it("applies package filters on top of manifest filters", async () => {
			const pkgDir = join(tempDir, "filtered-pkg");
			mkdirSync(join(pkgDir, "themes"), { recursive: true });
			writeFileSync(join(pkgDir, "themes", "nice.json"), "{}");
			writeFileSync(join(pkgDir, "themes", "ugly.json"), "{}");
			writeFileSync(
				join(pkgDir, "package.json"),
				JSON.stringify({
					name: "filtered-pkg",
					pi: {
						themes: ["themes"],
					},
				}),
			);

			settingsManager.setPackages([{ source: pkgDir, themes: ["!**/ugly.json"] }]);

			const result = await packageManager.resolve();
			expect(result.themes.some((r) => isEnabled(r, "nice.json"))).toBe(true);
			expect(result.themes.some((r) => isDisabled(r, "ugly.json"))).toBe(true);
		});

		it("dedupes resources from multiple packages by canonical path", async () => {
			const sharedPkg = join(tempDir, "shared-pkg");
			mkdirSync(join(sharedPkg, "themes"), { recursive: true });
			writeFileSync(join(sharedPkg, "themes", "shared.json"), "{}");

			settingsManager.setPackages([sharedPkg, sharedPkg]);

			const result = await packageManager.resolve();
			const sharedPaths = result.themes.filter((r) => r.path.includes("shared-pkg"));
			expect(sharedPaths).toHaveLength(1);
		});
	});

	describe("settings source normalization", () => {
		it("stores global local packages relative to agent settings base", () => {
			const pkgDir = join(tempDir, "packages", "local-global-pkg");
			mkdirSync(join(pkgDir, "skills"), { recursive: true });

			const added = packageManager.addSourceToSettings("./packages/local-global-pkg");
			expect(added).toBe(true);

			const settings = settingsManager.getGlobalSettings();
			const rel = relative(agentDir, pkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("stores project local packages relative to .prime settings base", () => {
			const projectPkgDir = join(tempDir, "project-local-pkg");
			mkdirSync(join(projectPkgDir, "skills"), { recursive: true });

			const added = packageManager.addSourceToSettings("./project-local-pkg", { local: true });
			expect(added).toBe(true);

			const settings = settingsManager.getProjectSettings();
			const rel = relative(join(tempDir, ".prime", "agent"), projectPkgDir);
			const expected = rel.startsWith(".") ? rel : `./${rel}`;
			expect(settings.packages?.[0]).toBe(expected);
		});

		it("removes local package entries using equivalent path forms", () => {
			const pkgDir = join(tempDir, "remove-local-pkg");
			mkdirSync(join(pkgDir, "skills"), { recursive: true });

			packageManager.addSourceToSettings("./remove-local-pkg");
			const removed = packageManager.removeSourceFromSettings(`${pkgDir}/`);
			expect(removed).toBe(true);
			expect(settingsManager.getGlobalSettings().packages ?? []).toHaveLength(0);
		});
	});

	describe("source parsing", () => {
		it("parses package source types", () => {
			const internals = packageManager as unknown as PackageManagerInternals;

			expect(internals.parseSource("npm:@scope/pkg@1.2.3").type).toBe("npm");
			expect(internals.parseSource("git:github.com/user/repo@v1").type).toBe("git");
			expect(internals.parseSource("https://github.com/user/repo@v1").type).toBe("git");
			expect(internals.parseSource("/absolute/path/to/package").type).toBe("local");
			expect(internals.parseSource("./relative/path/to/package").type).toBe("local");
			expect(internals.parseSource("../relative/path/to/package").type).toBe("local");
		});

		it("generates stable package identities for supported git URL formats", () => {
			const internals = packageManager as unknown as PackageManagerInternals;

			const identity1 = internals.getPackageIdentity("https://github.com/user/repo");
			const identity2 = internals.getPackageIdentity("https://github.com/user/repo@v1.0.0");
			const identity3 = internals.getPackageIdentity("git:github.com/user/repo");
			const identity4 = internals.getPackageIdentity("https://github.com/user/repo.git");

			expect(identity1).toBe("git:github.com/user/repo");
			expect(identity1).toBe(identity2);
			expect(identity2).toBe(identity3);
			expect(identity3).toBe(identity4);
		});
	});

	describe("windows command spawning", () => {
		it("avoids the shell for git so Windows paths with spaces stay single arguments", () => {
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");

			expect(shouldUseWindowsShell("git")).toBe(false);
			expect(shouldUseWindowsShell("npm")).toBe(true);
			expect(shouldUseWindowsShell("pnpm")).toBe(true);
			expect(shouldUseWindowsShell("C:/Program Files/nodejs/npm.cmd")).toBe(true);
		});
	});
});
