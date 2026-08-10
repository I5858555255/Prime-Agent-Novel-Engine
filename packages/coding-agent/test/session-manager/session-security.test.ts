import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";

describe("SessionManager artifact security", () => {
	it("rejects traversal IDs in session headers", () => {
		const root = mkdtempSync(join(tmpdir(), "session-security-"));
		try {
			const sessionDir = join(root, "sessions");
			mkdirSync(sessionDir);
			const sessionFile = join(sessionDir, "attacker.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					id: "../../../../tmp/attacker-controlled",
					timestamp: new Date().toISOString(),
					cwd: root,
				})}\n`,
			);
			expect(() => SessionManager.open(sessionFile, sessionDir)).toThrow("Invalid session header id");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects artifact directories that resolve outside the artifact root", () => {
		const root = mkdtempSync(join(tmpdir(), "session-artifact-security-"));
		try {
			const sessionDir = join(root, "sessions");
			const artifactRoot = join(root, "session-artifacts");
			const outside = join(root, "outside");
			mkdirSync(sessionDir);
			mkdirSync(artifactRoot);
			mkdirSync(outside);
			const session = SessionManager.create(root, sessionDir);
			const artifact = join(artifactRoot, session.getSessionId());
			symlinkSync(outside, artifact);
			expect(() => session.getSessionArtifactDir()).toThrow(/escapes root|must not contain a symlink/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
