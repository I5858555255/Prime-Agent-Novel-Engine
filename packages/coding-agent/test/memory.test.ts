import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMemoryDirs, getMemoryDirs, runMemoryCommand } from "../src/core/memory/index.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";

let tempRoot = "";

afterEach(() => {
	if (tempRoot) {
		rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = "";
	}
});

function createMemoryOptions() {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-memory-"));
	const cwd = join(tempRoot, "project");
	const globalMemoryDir = join(tempRoot, "global-memory");
	mkdirSync(cwd, { recursive: true });
	return { cwd, globalMemoryDir };
}

describe("memory paths", () => {
	it("returns global and project memory directories", () => {
		const options = createMemoryOptions();
		const dirs = getMemoryDirs(options);

		expect(dirs.global).toBe(options.globalMemoryDir);
		expect(dirs.project).toBe(join(options.cwd, ".prime-agent", "memory"));
	});

	it("creates memory directories idempotently", () => {
		const options = createMemoryOptions();
		const first = ensureMemoryDirs(options);
		const second = ensureMemoryDirs(options);

		expect(existsSync(first.global)).toBe(true);
		expect(existsSync(first.project)).toBe(true);
		expect(second).toEqual(first);
	});
});

describe("/memory command", () => {
	it("is registered as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "memory")).toBe(true);
	});

	it("lists global and project memory files", () => {
		const options = createMemoryOptions();
		const dirs = ensureMemoryDirs(options);
		writeFileSync(join(dirs.global, "user-prefs.md"), "terse prose");
		writeFileSync(join(dirs.project, "project-notes.md"), "project note");

		const output = runMemoryCommand("list", options);

		expect(output).toContain(`Global: ${dirs.global}`);
		expect(output).toContain(`Project: ${dirs.project}`);
		expect(output).toContain("user-prefs.md");
		expect(output).toContain("project-notes.md");
	});

	it("shows a memory file by relative path", () => {
		const options = createMemoryOptions();
		const dirs = ensureMemoryDirs(options);
		writeFileSync(join(dirs.global, "user-prefs.md"), "# Preferences\n- terse prose");

		const output = runMemoryCommand("show user-prefs.md", options);

		expect(output).toContain("Memory file: global/user-prefs.md");
		expect(output).toContain("# Preferences\n- terse prose");
	});

	it("requires a scope when a file path is ambiguous", () => {
		const options = createMemoryOptions();
		const dirs = ensureMemoryDirs(options);
		writeFileSync(join(dirs.global, "notes.md"), "global");
		writeFileSync(join(dirs.project, "notes.md"), "project");

		expect(() => runMemoryCommand("show notes.md", options)).toThrow(/Ambiguous memory file/);
		expect(runMemoryCommand("show project/notes.md", options)).toContain("project");
	});

	it("rejects paths outside memory directories", () => {
		const options = createMemoryOptions();
		ensureMemoryDirs(options);
		writeFileSync(join(tempRoot, "outside.md"), "outside");

		expect(() => runMemoryCommand("show ../outside.md", options)).toThrow(/inside a memory directory/);
	});

	it("clears memory files while keeping the directories", () => {
		const options = createMemoryOptions();
		const dirs = ensureMemoryDirs(options);
		writeFileSync(join(dirs.global, "user-prefs.md"), "global");
		writeFileSync(join(dirs.project, "project-notes.md"), "project");

		expect(runMemoryCommand("clear", options)).toBe("Cleared global and project memory.");
		expect(readdirSync(dirs.global)).toEqual([]);
		expect(readdirSync(dirs.project)).toEqual([]);
		expect(existsSync(dirs.global)).toBe(true);
		expect(existsSync(dirs.project)).toBe(true);
	});
});
