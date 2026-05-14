import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
	return [
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
	return BUILTIN_PYTHON_SKILLS.map((skill) => {
		if (!root) {
			return skill.packageName;
		}
		const localPackage = path.join(root, skill.directoryName);
		return existsSync(path.join(localPackage, "pyproject.toml")) ? localPackage : skill.packageName;
	});
}
