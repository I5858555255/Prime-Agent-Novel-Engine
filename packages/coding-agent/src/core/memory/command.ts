import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { ensureMemoryDirs } from "./init.js";
import type { MemoryDirs, MemoryPathOptions } from "./paths.js";

const MAX_MEMORY_FILE_BYTES = 128 * 1024;

type MemoryScope = keyof MemoryDirs;

interface MemoryFile {
	scope: MemoryScope;
	relativePath: string;
	absolutePath: string;
}

interface ParsedMemoryPath {
	scope?: MemoryScope;
	relativePath: string;
}

export interface RunMemoryCommandOptions extends MemoryPathOptions {
	maxFileBytes?: number;
}

function getScopeDir(dirs: MemoryDirs, scope: MemoryScope): string {
	return dirs[scope];
}

function parseMemoryPath(input: string): ParsedMemoryPath {
	const rawPath = input.trim();
	if (!rawPath) {
		throw new Error("Usage: /memory show <path>");
	}
	if (isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
		throw new Error("Memory paths must be relative to a memory directory.");
	}

	const slashPath = rawPath.replace(/\\/g, "/");
	const scopedMatch = slashPath.match(/^(global|project)\/(.+)$/);
	const scope = scopedMatch?.[1] as MemoryScope | undefined;
	const unscopedPath = scopedMatch ? scopedMatch[2] : slashPath;
	const normalized = posix.normalize(unscopedPath ?? "");

	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new Error("Memory paths must stay inside a memory directory.");
	}

	return {
		scope,
		relativePath: normalized,
	};
}

function resolveRelativeMemoryPath(root: string, relativePath: string): string {
	const rootPath = resolve(root);
	const targetPath = resolve(rootPath, ...relativePath.split("/"));
	const relativePathFromRoot = relative(rootPath, targetPath);
	if (
		relativePathFromRoot === ".." ||
		relativePathFromRoot.startsWith(`..${sep}`) ||
		isAbsolute(relativePathFromRoot)
	) {
		throw new Error("Memory paths must stay inside a memory directory.");
	}
	return targetPath;
}

function listMemoryFilesForScope(dirs: MemoryDirs, scope: MemoryScope): MemoryFile[] {
	const root = getScopeDir(dirs, scope);
	const files: MemoryFile[] = [];

	const walk = (dir: string, prefix: string): void => {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const absolutePath = join(dir, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(absolutePath, relativePath);
			} else if (entry.isFile()) {
				files.push({ scope, relativePath, absolutePath });
			}
		}
	};

	walk(root, "");
	return files;
}

function listMemoryFiles(dirs: MemoryDirs): MemoryFile[] {
	return [...listMemoryFilesForScope(dirs, "global"), ...listMemoryFilesForScope(dirs, "project")];
}

function resolveMemoryFile(dirs: MemoryDirs, input: string): MemoryFile {
	const parsed = parseMemoryPath(input);
	if (parsed.scope) {
		const absolutePath = resolveRelativeMemoryPath(getScopeDir(dirs, parsed.scope), parsed.relativePath);
		let isFile = false;
		try {
			isFile = lstatSync(absolutePath).isFile();
		} catch {
			throw new Error(`Memory file not found: ${input}`);
		}
		if (!isFile) {
			throw new Error(`Memory file not found: ${input}`);
		}
		return {
			scope: parsed.scope,
			relativePath: parsed.relativePath,
			absolutePath,
		};
	}

	const matches = listMemoryFiles(dirs).filter((file) => file.relativePath === parsed.relativePath);
	if (matches.length === 0) {
		throw new Error(`Memory file not found: ${input}`);
	}
	if (matches.length > 1) {
		throw new Error(`Ambiguous memory file: use global/${parsed.relativePath} or project/${parsed.relativePath}.`);
	}
	return matches[0]!;
}

function formatMemoryList(dirs: MemoryDirs): string {
	const files = listMemoryFiles(dirs);
	const lines = ["Memory directories", `Global: ${dirs.global}`, `Project: ${dirs.project}`, "", "Files"];

	for (const scope of ["global", "project"] as const) {
		lines.push(`${scope}:`);
		const scopedFiles = files.filter((file) => file.scope === scope);
		if (scopedFiles.length === 0) {
			lines.push("  (empty)");
			continue;
		}
		for (const file of scopedFiles) {
			lines.push(`  ${file.relativePath}`);
		}
	}

	return lines.join("\n");
}

function showMemoryFile(dirs: MemoryDirs, inputPath: string, maxFileBytes: number): string {
	const file = resolveMemoryFile(dirs, inputPath);
	const bytes = readFileSync(file.absolutePath);
	const truncated = bytes.byteLength > maxFileBytes;
	const content = bytes.subarray(0, maxFileBytes).toString("utf-8");
	const lines = [`Memory file: ${file.scope}/${file.relativePath}`, file.absolutePath, "", content];
	if (truncated) {
		lines.push("", `[truncated after ${maxFileBytes} bytes]`);
	}
	return lines.join("\n");
}

function clearMemoryDir(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		rmSync(join(dir, entry.name), { recursive: true, force: true });
	}
}

function clearMemory(dirs: MemoryDirs, scope: MemoryScope | "all"): string {
	if (scope === "all" || scope === "global") {
		clearMemoryDir(dirs.global);
	}
	if (scope === "all" || scope === "project") {
		clearMemoryDir(dirs.project);
	}

	const label = scope === "all" ? "global and project" : scope;
	return `Cleared ${label} memory.`;
}

function parseClearScope(scope: string | undefined): MemoryScope | "all" {
	if (!scope || scope === "all") {
		return "all";
	}
	if (scope === "global" || scope === "project") {
		return scope;
	}
	throw new Error("Usage: /memory clear [global|project|all]");
}

export function runMemoryCommand(args: string, options: RunMemoryCommandOptions): string {
	const dirs = ensureMemoryDirs(options);
	const trimmedArgs = args.trim();
	if (!trimmedArgs || trimmedArgs === "list") {
		return formatMemoryList(dirs);
	}

	const [action, ...rest] = trimmedArgs.split(/\s+/);
	if (action === "show") {
		return showMemoryFile(dirs, rest.join(" "), options.maxFileBytes ?? MAX_MEMORY_FILE_BYTES);
	}
	if (action === "clear") {
		return clearMemory(dirs, parseClearScope(rest[0]));
	}

	throw new Error("Usage: /memory [list|show <path>|clear [global|project|all]]");
}
