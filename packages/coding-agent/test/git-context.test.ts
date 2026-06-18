import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGitContext, gitContextsEqual } from "../src/utils/git.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

function writeGitFile(gitDir: string, relPath: string, content: string): void {
	const full = join(gitDir, relPath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

describe("captureGitContext", () => {
	let dir: string;
	let gitDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "git-context-"));
		gitDir = join(dir, ".git");
		mkdirSync(gitDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads branch, commit, and normalized repo url from loose refs", () => {
		writeGitFile(gitDir, "HEAD", "ref: refs/heads/main\n");
		writeGitFile(gitDir, "refs/heads/main", `${SHA}\n`);
		writeGitFile(gitDir, "config", '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n');

		expect(captureGitContext(dir)).toEqual({
			branch: "main",
			commit: SHA,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("resolves a commit from packed-refs when no loose ref exists", () => {
		writeGitFile(gitDir, "HEAD", "ref: refs/heads/feature\n");
		writeGitFile(gitDir, "packed-refs", `# pack-refs with: peeled fully-peeled sorted\n${SHA2} refs/heads/feature\n`);

		expect(captureGitContext(dir)).toMatchObject({ branch: "feature", commit: SHA2 });
	});

	it("reports a detached HEAD as a commit with no branch", () => {
		writeGitFile(gitDir, "HEAD", `${SHA}\n`);

		const ctx = captureGitContext(dir);
		expect(ctx?.commit).toBe(SHA);
		expect(ctx?.branch).toBeUndefined();
	});

	it("omits repo url when there is no origin remote", () => {
		writeGitFile(gitDir, "HEAD", "ref: refs/heads/main\n");
		writeGitFile(gitDir, "refs/heads/main", `${SHA}\n`);

		const ctx = captureGitContext(dir);
		expect(ctx?.repoUrl).toBeUndefined();
		expect(ctx?.commit).toBe(SHA);
	});

	it("keeps an ssh remote url verbatim when it cannot be normalized", () => {
		writeGitFile(gitDir, "HEAD", `${SHA}\n`);
		writeGitFile(gitDir, "config", '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n');

		expect(captureGitContext(dir)?.repoUrl).toBe("git@github.com:acme/widgets.git");
	});

	it("returns null outside a git repo", () => {
		expect(captureGitContext(dir)).toBeNull();
	});
});

describe("gitContextsEqual", () => {
	it("compares all fields", () => {
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA, branch: "main" })).toBe(true);
		expect(gitContextsEqual({ commit: SHA, branch: "main" }, { commit: SHA2, branch: "main" })).toBe(false);
		expect(gitContextsEqual({ commit: SHA }, { commit: SHA, branch: "main" })).toBe(false);
	});
});
