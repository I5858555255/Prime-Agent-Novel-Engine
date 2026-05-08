import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MEMORY_STATE_DIR_NAME = ".prime-agent";
export const MEMORY_DIR_NAME = "memory";

export interface MemoryDirs {
	global: string;
	project: string;
}

export interface MemoryPathOptions {
	cwd: string;
	globalMemoryDir?: string;
	projectMemoryDir?: string;
}

export function getGlobalMemoryDir(): string {
	return join(homedir(), MEMORY_STATE_DIR_NAME, MEMORY_DIR_NAME);
}

export function getProjectMemoryDir(cwd: string): string {
	return join(resolve(cwd), MEMORY_STATE_DIR_NAME, MEMORY_DIR_NAME);
}

export function getMemoryDirs(options: MemoryPathOptions): MemoryDirs {
	return {
		global: options.globalMemoryDir ?? getGlobalMemoryDir(),
		project: options.projectMemoryDir ?? getProjectMemoryDir(options.cwd),
	};
}

export function formatMemoryPathForPrompt(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}
