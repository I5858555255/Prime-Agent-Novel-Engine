import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getMemoryDirs, type MemoryDirs, type MemoryPathOptions } from "./paths.js";

function assertDirectory(dir: string): void {
	const stat = statSync(dir);
	if (!stat.isDirectory()) {
		throw new Error(`Memory path is not a directory: ${dir}`);
	}
}

export function ensureMemoryDirs(options: MemoryPathOptions): MemoryDirs {
	const dirs = getMemoryDirs(options);
	mkdirSync(dirs.global, { recursive: true });
	mkdirSync(dirs.project, { recursive: true });
	assertDirectory(dirs.global);
	assertDirectory(dirs.project);
	return dirs;
}

export function ensureMemoryDirsForExistingCwd(options: MemoryPathOptions): MemoryDirs {
	const dirs = getMemoryDirs(options);
	try {
		if (!statSync(resolve(options.cwd)).isDirectory()) {
			return dirs;
		}
		return ensureMemoryDirs(options);
	} catch {
		return dirs;
	}
}
