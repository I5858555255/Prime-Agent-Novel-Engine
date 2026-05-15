import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getBuiltinPythonSkillSourceDirs,
	getBuiltinPythonSkillsRoot,
	withBuiltinPythonSkillsEnv,
} from "../src/core/builtin-python-skills.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";

describe("built-in Python skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let originalPiPackageDir: string | undefined;
	let originalPythonPath: string | undefined;

	beforeEach(() => {
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalPythonPath = process.env.PYTHONPATH;
		tempDir = join(tmpdir(), `prime-agent-builtin-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		if (originalPythonPath === undefined) {
			delete process.env.PYTHONPATH;
		} else {
			process.env.PYTHONPATH = originalPythonPath;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads websearch by default", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const skill = loader.getSkills().skills.find((s) => s.name === "websearch");
		expect(skill?.filePath).toContain(join("python-skills", "websearch", "SKILL.md"));
		expect(skill?.sourceInfo).toMatchObject({
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
	});

	it("honors noSkills for built-in Python skills", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
		await loader.reload();

		expect(loader.getSkills().skills.some((s) => s.name === "websearch")).toBe(false);
	});

	it("resolves binary package assets through PI_PACKAGE_DIR", () => {
		const packageDir = join(tempDir, "package");
		const websearchDir = join(packageDir, "python-skills", "websearch");
		const sourceDir = join(websearchDir, "src");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(websearchDir, "SKILL.md"), "---\nname: websearch\ndescription: test\n---\n");
		process.env.PI_PACKAGE_DIR = packageDir;
		delete process.env.PYTHONPATH;

		expect(getBuiltinPythonSkillsRoot()).toBe(join(packageDir, "python-skills"));
		expect(getBuiltinPythonSkillSourceDirs()).toEqual([sourceDir]);
		expect(withBuiltinPythonSkillsEnv({ EXTRA: "1" })).toEqual({
			EXTRA: "1",
			PYTHONPATH: sourceDir,
		});
	});

	it("prepends built-in skill sources to an existing PYTHONPATH", () => {
		const packageDir = join(tempDir, "package");
		const sourceDir = join(packageDir, "python-skills", "websearch", "src");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(
			join(packageDir, "python-skills", "websearch", "SKILL.md"),
			"---\nname: websearch\ndescription: test\n---\n",
		);
		process.env.PI_PACKAGE_DIR = packageDir;
		process.env.PYTHONPATH = "/existing/path";

		expect(withBuiltinPythonSkillsEnv().PYTHONPATH).toBe(`${sourceDir}${delimiter}/existing/path`);
	});
});
