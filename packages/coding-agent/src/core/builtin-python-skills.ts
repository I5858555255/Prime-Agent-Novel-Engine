import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../config.js";

export interface BuiltinPythonSkill {
	name: string;
	importName: string;
	packageName: string;
	directoryName: string;
}

export const BUILTIN_PYTHON_SKILLS: BuiltinPythonSkill[] = [
	{
		name: "websearch",
		importName: "websearch",
		packageName: "prime-agent-skill-websearch",
		directoryName: "websearch",
	},
];

export const BUILTIN_PYTHON_SKILL_IMPORTS = BUILTIN_PYTHON_SKILLS.map((skill) => skill.importName);
export const BUILTIN_PYTHON_SKILL_PACKAGES = BUILTIN_PYTHON_SKILLS.map((skill) => skill.packageName);

function candidatePythonSkillsRoots(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const packageDir = getPackageDir();
	return [
		path.join(packageDir, "python-skills"),
		path.join(packageDir, "dist", "python-skills"),
		path.resolve(packageDir, "..", "..", "packages", "python-skills"),
		path.resolve(moduleDir, "..", "python-skills"),
		path.resolve(moduleDir, "..", "..", "..", "python-skills"),
		path.resolve(moduleDir, "..", "..", "..", "..", "packages", "python-skills"),
	];
}

export function getBuiltinPythonSkillsRoot(): string | undefined {
	for (const candidate of candidatePythonSkillsRoots()) {
		if (BUILTIN_PYTHON_SKILLS.every((skill) => existsSync(path.join(candidate, skill.directoryName, "SKILL.md")))) {
			return candidate;
		}
	}
	return undefined;
}

export function getBuiltinPythonSkillRequirements(): string[] {
	const root = getBuiltinPythonSkillsRoot();
	if (!root) {
		throw new Error("Bundled built-in Python skills were not found in the prime-agent package assets.");
	}
	return BUILTIN_PYTHON_SKILLS.map((skill) => {
		const localPackage = path.join(root, skill.directoryName);
		if (!existsSync(path.join(localPackage, "pyproject.toml"))) {
			throw new Error(`Bundled built-in Python skill package is missing pyproject.toml: ${localPackage}`);
		}
		return localPackage;
	});
}
