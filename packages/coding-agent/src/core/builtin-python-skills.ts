import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../config.js";

export interface BuiltinPythonSkill {
	name: string;
	importName: string;
	directoryName: string;
}

export const BUILTIN_PYTHON_SKILLS: BuiltinPythonSkill[] = [
	{
		name: "websearch",
		importName: "websearch",
		directoryName: "websearch",
	},
];

export const BUILTIN_PYTHON_SKILL_IMPORTS = BUILTIN_PYTHON_SKILLS.map((skill) => skill.importName);

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

export function getBuiltinPythonSkillSourceDirs(): string[] {
	const root = getBuiltinPythonSkillsRoot();
	if (!root) {
		throw new Error("Bundled built-in Python skills were not found in the prime-agent package assets.");
	}
	return BUILTIN_PYTHON_SKILLS.map((skill) => {
		const sourceDir = path.join(root, skill.directoryName, "src");
		if (!existsSync(sourceDir)) {
			throw new Error(`Bundled built-in Python skill source directory is missing: ${sourceDir}`);
		}
		return sourceDir;
	});
}

export function withBuiltinPythonSkillsEnv(env: Record<string, string> = {}): Record<string, string> {
	const sourceDirs = getBuiltinPythonSkillSourceDirs();
	const existingPythonPath = env.PYTHONPATH ?? process.env.PYTHONPATH;
	return {
		...env,
		PYTHONPATH: [...sourceDirs, ...(existingPythonPath ? [existingPythonPath] : [])].join(path.delimiter),
	};
}
