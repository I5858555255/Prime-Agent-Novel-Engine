import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const biomeBinary = path.join(repositoryRoot, "node_modules", ".bin", "biome");
const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function runGit(directory: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
}

function initializeRepository(directory: string, files: Record<string, string>): void {
	runGit(directory, "init", "--quiet");
	runGit(directory, "config", "user.email", "validation-test@example.invalid");
	runGit(directory, "config", "user.name", "Validation Test");
	for (const [file, contents] of Object.entries(files)) {
		writeFileSync(path.join(directory, file), contents);
	}
	runGit(directory, "add", ...Object.keys(files));
	runGit(directory, "commit", "--quiet", "-m", "fixture");
}

function snapshotRepository(directory: string, files: string[]): Record<string, string> {
	return {
		cachedDiff: runGit(directory, "diff", "--cached", "--binary"),
		diff: runGit(directory, "diff", "--binary"),
		status: runGit(directory, "status", "--short"),
		...Object.fromEntries(files.map((file) => [file, readFileSync(path.join(directory, file), "utf8")])),
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("non-mutating validation workflow", () => {
	it("keeps a pre-existing dirty worktree byte-identical", () => {
		const directory = makeTemporaryDirectory("prime-agent-check-dirty-");
		initializeRepository(directory, { "sentinel.ts": "export const sentinel = 1;\n" });
		writeFileSync(path.join(directory, "sentinel.ts"), "export const sentinel = 2;\n");
		const before = snapshotRepository(directory, ["sentinel.ts"]);

		const result = spawnSync(biomeBinary, ["check", "--error-on-warnings", "sentinel.ts"], {
			cwd: directory,
			encoding: "utf8",
		});

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(snapshotRepository(directory, ["sentinel.ts"])).toEqual(before);
	});

	it("fails on a formatting violation without repairing the fixture", () => {
		const directory = makeTemporaryDirectory("prime-agent-check-format-");
		initializeRepository(directory, { "invalid.ts": "export const invalid = { value: 1 };\n" });
		writeFileSync(path.join(directory, "invalid.ts"), "export const invalid={value:1}\n");
		const before = snapshotRepository(directory, ["invalid.ts"]);

		const result = spawnSync(biomeBinary, ["check", "--error-on-warnings", "invalid.ts"], {
			cwd: directory,
			encoding: "utf8",
		});

		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("invalid.ts format");
		expect(snapshotRepository(directory, ["invalid.ts"])).toEqual(before);
	});

	it("does not restage files that also have unstaged changes", () => {
		const directory = makeTemporaryDirectory("prime-agent-check-hook-");
		initializeRepository(directory, {
			"partially-staged.ts": "export const staged = 1;\n",
			"unstaged.ts": "export const unstaged = 1;\n",
		});
		writeFileSync(path.join(directory, "partially-staged.ts"), "export const staged = 2;\n");
		runGit(directory, "add", "partially-staged.ts");
		writeFileSync(path.join(directory, "partially-staged.ts"), "export const staged = 3;\n");
		writeFileSync(path.join(directory, "unstaged.ts"), "export const unstaged = 2;\n");
		const binaryDirectory = path.join(directory, "bin");
		mkdirSync(binaryDirectory);
		const npmStub = path.join(binaryDirectory, "npm");
		writeFileSync(npmStub, '#!/bin/sh\n[ "$1" = "run" ] && [ "$2" = "check" ]\n');
		chmodSync(npmStub, 0o755);
		const before = snapshotRepository(directory, ["partially-staged.ts", "unstaged.ts"]);
		const result = spawnSync("sh", [path.join(repositoryRoot, ".husky", "pre-commit")], {
			cwd: directory,
			encoding: "utf8",
			env: { ...process.env, PATH: `${binaryDirectory}:${process.env.PATH ?? ""}` },
		});

		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(snapshotRepository(directory, ["partially-staged.ts", "unstaged.ts"])).toEqual(before);
	});

	it("keeps write mode explicit and guards CI against mutations", () => {
		const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		const workflow = readFileSync(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");

		expect(packageJson.scripts["check:format"]).toBe("biome check --error-on-warnings .");
		expect(packageJson.scripts.check).not.toContain("--write");
		expect(packageJson.scripts.format).toBe("biome check --write .");
		expect(workflow).toMatch(/run: npm run check[\s\S]*run: git diff --exit-code/);
		expect(workflow).not.toContain("npm run format");
	});
});
