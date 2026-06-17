import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionContext, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager agent status", () => {
	it("persists the latest agent status append-only and reads it back", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-status-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("add a login endpoint"));
			session.appendMessage(assistantMsg("done"));
			session.appendAgentStatus({ summary: "Working", taskState: undefined, basedOnMessageCount: 2 });
			session.appendAgentStatus({ summary: "Added login endpoint", taskState: "completed", basedOnMessageCount: 2 });

			// Latest entry wins.
			expect(session.getLatestAgentStatus()).toEqual({
				summary: "Added login endpoint",
				taskState: "completed",
				basedOnMessageCount: 2,
			});

			// Append-only: re-reading the raw file recovers both entries and the
			// two conversation messages untouched.
			const entries = loadEntriesFromFile(session.getSessionFile()!);
			expect(entries.filter((entry) => entry.type === "agent_status")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("is ignored by context building so it never reaches the model", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "agent-status-context-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			session.appendAgentStatus({ summary: "Greeted the user", taskState: "completed", basedOnMessageCount: 2 });

			const context = buildSessionContext(session.getEntries(), session.getLeafId());
			expect(context.messages).toHaveLength(2);
			expect(context.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(
				true,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
