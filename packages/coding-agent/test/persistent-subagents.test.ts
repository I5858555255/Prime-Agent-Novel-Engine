import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSubagentSessionManager,
	findPersistentSubagentSessionFile,
	loadPersistentSubagentRecord,
	persistentSubagentDir,
	persistentSubagentNodeId,
	planPersistentSubagentRun,
	savePersistentSubagentRecord,
	slugifyPersistentSubagentId,
} from "../src/core/persistent-subagents.js";
import { SessionManager } from "../src/core/session-manager.js";

function assistantEntry() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "prior answer" }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** Create a subagent session file on disk under dir with one flushed turn. */
function writeSubagentSession(cwd: string, dir: string): string {
	const manager = SessionManager.create(cwd, dir);
	manager.materializeSessionFile(dir);
	manager.appendMessage({ role: "user", content: "prior instruction", timestamp: Date.now() });
	manager.appendMessage(assistantEntry());
	return manager.getSessionFile()!;
}

describe("persistent subagents store", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-persist-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("slugs ids into filesystem-safe directory names", () => {
		expect(slugifyPersistentSubagentId("Code Reviewer!")).toBe("code_reviewer");
		expect(slugifyPersistentSubagentId("  ")).toBe("subagent");
		expect(persistentSubagentNodeId("Code Reviewer")).toBe("persist-code_reviewer");
		expect(persistentSubagentDir(tempDir, "Code Reviewer")).toBe(
			join(tempDir, "persistent-subagents", "code_reviewer"),
		);
	});

	it("plans a fresh run when no prior subagent exists", () => {
		const plan = planPersistentSubagentRun({ rootDir: tempDir, id: "reviewer", systemPrompt: "role" });

		expect(plan.reopened).toBe(false);
		expect(plan.existingSessionFile).toBeUndefined();
		expect(plan.systemPrompt).toBe("role");
		expect(plan.record.runCount).toBe(1);
		expect(plan.nodeId).toBe("persist-reviewer");
	});

	it("reopens and reuses the stored system prompt on the next plan", () => {
		const plan1 = planPersistentSubagentRun({ rootDir: tempDir, id: "reviewer", systemPrompt: "role" });
		// Simulate a finished run: a session file plus the saved sidecar pointer.
		const sessionFile = writeSubagentSession(tempDir, plan1.dir);
		savePersistentSubagentRecord(plan1.dir, { ...plan1.record, sessionFile });

		const plan2 = planPersistentSubagentRun({ rootDir: tempDir, id: "reviewer" });
		expect(plan2.reopened).toBe(true);
		expect(plan2.existingSessionFile).toBe(sessionFile);
		expect(plan2.systemPrompt).toBe("role");
		expect(plan2.record.runCount).toBe(2);
		expect(plan2.record.createdAt).toBe(plan1.record.createdAt);
	});

	it("finds the newest session file when the sidecar pointer is absent", () => {
		const dir = persistentSubagentDir(tempDir, "reviewer");
		const sessionFile = writeSubagentSession(tempDir, dir);
		expect(findPersistentSubagentSessionFile(dir, undefined)).toBe(sessionFile);
	});

	it("createSubagentSessionManager reopens an existing session and hydrates history", () => {
		const dir = persistentSubagentDir(tempDir, "reviewer");
		const sessionFile = writeSubagentSession(tempDir, dir);

		const reopened = createSubagentSessionManager({
			cwd: tempDir,
			sessionDir: dir,
			existingSessionFile: sessionFile,
		});
		expect(reopened.getSessionFile()).toBe(sessionFile);
		expect(reopened.buildSessionContext().messages.length).toBeGreaterThanOrEqual(2);
	});

	it("createSubagentSessionManager starts a fresh linked session when none exists", () => {
		const dir = persistentSubagentDir(tempDir, "fresh");
		const manager = createSubagentSessionManager({
			cwd: tempDir,
			sessionDir: dir,
			parentSessionFile: join(tempDir, "parent.jsonl"),
		});
		expect(manager.buildSessionContext().messages.length).toBe(0);
	});

	it("ignores a corrupt sidecar", () => {
		const dir = persistentSubagentDir(tempDir, "reviewer");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "subagent.json"), "{ not valid json");
		expect(loadPersistentSubagentRecord(dir)).toBeUndefined();
	});
});
