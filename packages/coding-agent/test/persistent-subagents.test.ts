import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSubagentSessionManager,
	findPersistentSubagentSessionFile,
	loadPersistentSubagentRecord,
	persistentSubagentDir,
	persistentSubagentNodeId,
	persistentSubagentSessionHasHistory,
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

	it("slugs ids into readable, collision-resistant directory names", () => {
		// Readable prefix preserved, plus a hash of the exact id.
		expect(slugifyPersistentSubagentId("Code Reviewer!")).toMatch(/^code_reviewer-[0-9a-f]{8}$/);
		expect(slugifyPersistentSubagentId("  ")).toMatch(/^subagent-[0-9a-f]{8}$/);
		expect(persistentSubagentNodeId("Code Reviewer")).toBe(`persist-${slugifyPersistentSubagentId("Code Reviewer")}`);
		expect(persistentSubagentDir(tempDir, "Code Reviewer")).toBe(
			join(tempDir, "persistent-subagents", slugifyPersistentSubagentId("Code Reviewer")),
		);
	});

	it("keeps distinct ids that normalize identically from colliding", () => {
		const ids = ["reviewer-1", "Reviewer 1", "reviewer_1", "Reviewer", "reviewer"];
		const slugs = ids.map(slugifyPersistentSubagentId);
		expect(new Set(slugs).size).toBe(ids.length);
		const dirs = ids.map((id) => persistentSubagentDir(tempDir, id));
		expect(new Set(dirs).size).toBe(ids.length);
		// Same id is always stable.
		expect(slugifyPersistentSubagentId("reviewer")).toBe(slugifyPersistentSubagentId("reviewer"));
	});

	it("plans a fresh run when no prior subagent exists", () => {
		const plan = planPersistentSubagentRun({ rootDir: tempDir, id: "reviewer", systemPrompt: "role" });

		expect(plan.reopened).toBe(false);
		expect(plan.existingSessionFile).toBeUndefined();
		expect(plan.systemPrompt).toBe("role");
		expect(plan.record.runCount).toBe(1);
		expect(plan.nodeId).toBe(persistentSubagentNodeId("reviewer"));
	});

	it("does not report a reopen for a session file with no chat turns", () => {
		const plan1 = planPersistentSubagentRun({ rootDir: tempDir, id: "meta", systemPrompt: "role" });
		// A leftover JSONL with only a header and metadata (model/thinking) entries, no
		// user/assistant turns, as could be left behind by a run that never produced a turn.
		const dir = plan1.dir;
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "0192aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "0192aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		};
		const modelChange = {
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: new Date().toISOString(),
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		};
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(modelChange)}\n`);
		savePersistentSubagentRecord(dir, { ...plan1.record, sessionFile });

		expect(existsSync(sessionFile)).toBe(true);
		expect(findPersistentSubagentSessionFile(dir, undefined)).toBe(sessionFile);
		// No conversation turns, so it must not count as a reopen (which would hydrate
		// nothing while re-appending metadata).
		expect(persistentSubagentSessionHasHistory(sessionFile)).toBe(false);

		const plan2 = planPersistentSubagentRun({ rootDir: tempDir, id: "meta" });
		expect(plan2.reopened).toBe(false);
		expect(plan2.existingSessionFile).toBeUndefined();
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
