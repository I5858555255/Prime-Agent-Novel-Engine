import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBuiltinPythonSkillRequirements, getBuiltinPythonSkillsRoot } from "../src/core/builtin-python-skills.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";

describe("built-in Python skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let originalPiPackageDir: string | undefined;

	beforeEach(() => {
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
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
		mkdirSync(websearchDir, { recursive: true });
		writeFileSync(join(websearchDir, "SKILL.md"), "---\nname: websearch\ndescription: test\n---\n");
		writeFileSync(join(websearchDir, "pyproject.toml"), '[project]\nname = "prime-agent-skill-websearch"\n');
		process.env.PI_PACKAGE_DIR = packageDir;

		expect(getBuiltinPythonSkillsRoot()).toBe(join(packageDir, "python-skills"));
		expect(getBuiltinPythonSkillRequirements()).toEqual([websearchDir]);
	});
});
