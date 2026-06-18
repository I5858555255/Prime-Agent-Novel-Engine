import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";

function setHead(gitDir: string, sha: string): void {
	writeFileSync(join(gitDir, "refs", "heads", "main"), `${sha}\n`);
}

describe("SessionManager git state", () => {
	let repoDir: string;
	let gitDir: string;
	let sessionDir: string;

	beforeEach(() => {
		repoDir = mkdtempSync(join(tmpdir(), "sm-git-repo-"));
		sessionDir = mkdtempSync(join(tmpdir(), "sm-git-sessions-"));
		gitDir = join(repoDir, ".git");
		mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(gitDir, "config"), '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n');
		setHead(gitDir, SHA);
	});

	afterEach(() => {
		rmSync(repoDir, { recursive: true, force: true });
		rmSync(sessionDir, { recursive: true, force: true });
	});

	it("captures git context in the session header", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		expect(sm.getHeader()?.git).toEqual({
			branch: "main",
			commit: SHA,
			repoUrl: "https://github.com/acme/widgets.git",
		});
	});

	it("does not record a git_state entry when nothing changed", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		expect(sm.recordGitStateIfChanged()).toBeUndefined();
		expect(sm.getEntries().some((e) => e.type === "git_state")).toBe(false);
	});

	it("records a git_state entry when the commit changes", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		setHead(gitDir, SHA2);

		const id = sm.recordGitStateIfChanged();
		expect(id).toBeDefined();

		const entry = sm.getEntries().find((e) => e.type === "git_state");
		expect(entry).toMatchObject({ type: "git_state", git: { commit: SHA2 } });

		// A second call with no further change is a no-op.
		expect(sm.recordGitStateIfChanged()).toBeUndefined();
	});

	it("keeps git_state entries out of the LLM context", () => {
		const sm = SessionManager.create(repoDir, sessionDir);
		setHead(gitDir, SHA2);
		sm.recordGitStateIfChanged();
		expect(sm.buildSessionContext().messages).toHaveLength(0);
	});
});
