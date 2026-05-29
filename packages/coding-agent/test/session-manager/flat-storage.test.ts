import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager flat storage", () => {
	it("stores sessions directly in the session root and filters current-cwd lists", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-flat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const cwdA = join(tempDir, "project-a");
			const cwdB = join(tempDir, "project-b");
			const sessionA = createPersistedSession(cwdA, sessionDir, "a");
			const sessionB = createPersistedSession(cwdB, sessionDir, "b");

			const files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
			expect(files).toHaveLength(2);
			expect(files.some((file) => file.startsWith("--"))).toBe(false);

			const currentSessions = await SessionManager.list(cwdA, sessionDir);
			expect(currentSessions.map((session) => session.id)).toEqual([sessionA.getSessionId()]);

			const continued = SessionManager.continueRecent(cwdA, sessionDir);
			expect(continued.getSessionId()).toBe(sessionA.getSessionId());

			const allIds = new Set([sessionA.getSessionId(), sessionB.getSessionId()]);
			expect(new Set(files.map((file) => file.slice(file.indexOf("_") + 1, -".jsonl".length)))).toEqual(allIds);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

function createPersistedSession(cwd: string, sessionDir: string, text: string): SessionManager {
	const session = SessionManager.create(cwd, sessionDir);
	session.appendMessage(userMsg(text));
	session.appendMessage(assistantMsg(text));
	return session;
}
