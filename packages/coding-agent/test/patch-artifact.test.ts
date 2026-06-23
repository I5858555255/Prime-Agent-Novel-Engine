import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPatchArtifact, type PatchArtifactMetadata } from "../src/core/patch-artifact.js";
import type { SessionStats } from "../src/core/session-stats.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test User");
}

function commitAll(dir: string, message: string): void {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

const sessionStats: SessionStats = {
	sessionFile: undefined,
	sessionId: "session-1",
	userMessages: 1,
	assistantMessages: 2,
	toolCalls: 3,
	toolResults: 4,
	totalMessages: 7,
	tokens: {
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		total: 100,
	},
	cost: 0.12,
};

describe("createPatchArtifact", () => {
	let tempDir: string;
	let repoDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-patch-artifact-"));
		repoDir = join(tempDir, "repo");
		mkdirSync(repoDir);
		initRepo(repoDir);
		writeFileSync(join(repoDir, "app.txt"), "before\n");
		commitAll(repoDir, "init");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes patch, metadata, summary, and trajectory files", () => {
		writeFileSync(join(repoDir, "app.txt"), "after\n");
		writeFileSync(join(repoDir, "new.txt"), "new file\n");
		const sessionFile = join(tempDir, "session.jsonl");
		writeFileSync(sessionFile, '{"type":"session"}\n');

		const result = createPatchArtifact({
			cwd: repoDir,
			outputDir: join(tempDir, "artifact"),
			sessionFile,
			sessionStats,
			testsRun: ["npm test"],
			finalStatus: "tests_passed",
		});

		expect(result.status).toBe("ready");
		expect(result.changedFiles).toEqual(["app.txt", "new.txt"]);
		expect(result.untrackedFiles).toEqual(["new.txt"]);
		expect(existsSync(result.summaryPath)).toBe(true);
		expect(readFileSync(result.patchPath, "utf8")).toContain("+after");
		expect(readFileSync(result.patchPath, "utf8")).toContain("+new file");
		expect(readFileSync(result.trajectoryPath!, "utf8")).toContain('"type":"session"');

		const metadata = readJson<PatchArtifactMetadata>(result.metadataPath);
		expect(metadata.status).toBe("ready");
		expect(metadata.files.changed).toEqual(["app.txt", "new.txt"]);
		expect(metadata.trajectory?.path).toBe("trajectory.jsonl");
		expect(metadata.session?.sessionId).toBe("session-1");
		expect(metadata.testsRun).toEqual(["npm test"]);
		expect(metadata.finalStatus).toBe("tests_passed");
	});

	it("rejects dependency and setup churn by default", () => {
		writeFileSync(join(repoDir, "package.json"), '{"scripts":{"test":"true"}}\n');

		const result = createPatchArtifact({
			cwd: repoDir,
			outputDir: join(tempDir, "artifact-rejected"),
		});

		expect(result.status).toBe("rejected_setup_churn");
		expect(result.rejectedFiles).toEqual(["package.json"]);
		expect(readJson<PatchArtifactMetadata>(result.metadataPath).files.rejected).toEqual(["package.json"]);
		expect(readFileSync(result.patchPath, "utf8")).toContain('+{"scripts"');
	});

	it("allows setup churn when explicitly requested", () => {
		writeFileSync(join(repoDir, "requirements-dev.txt"), "pytest\n");

		const result = createPatchArtifact({
			cwd: repoDir,
			outputDir: join(tempDir, "artifact-allowed"),
			allowSetupChurn: true,
		});

		expect(result.status).toBe("ready");
		expect(result.rejectedFiles).toEqual([]);
		expect(result.changedFiles).toEqual(["requirements-dev.txt"]);
	});
});
