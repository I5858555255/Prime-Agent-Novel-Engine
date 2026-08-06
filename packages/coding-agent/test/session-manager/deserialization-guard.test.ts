import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, readSessionInfo, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager deserialization guard (H11)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-deser-guard-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("drops a message entry whose `message` payload is missing", async () => {
		const file = join(tempDir, "malformed-message.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s1",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				// Malformed: type "message" but no `message` field. Without the
				// guard this reaches buildSessionContext() and crashes on
				// `entry.message.role`.
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2026-01-01T00:00:02.000Z",
				}),
				JSON.stringify({
					type: "message",
					parentId: "m1",
					timestamp: "2026-01-01T00:00:03.000Z",
					message: { role: "user", content: "missing id", timestamp: 3 },
				}),
			].join("\n")}\n`,
		);

		// loadEntriesFromFile is the deserialization boundary used by both
		// setSessionFile and context-tree.ts.
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2); // header + m1 only
		expect(entries.find((e) => (e as { id?: string }).id === "m2")).toBeUndefined();

		const mgr = SessionManager.open(file, tempDir);
		expect(mgr.getEntries()).toHaveLength(1);
		expect(mgr.getEntries()[0]!.id).toBe("m1");
		expect(mgr.getLeafId()).toBe("m1");

		// Must not throw on the previously-crashing malformed leaf.
		expect(() => mgr.buildSessionContext()).not.toThrow();
		const ctx = mgr.buildSessionContext();
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0]!.role).toBe("user");
		await expect(readSessionInfo(file)).resolves.toMatchObject({ messageCount: 1 });
	});

	it("keeps v1 compaction indexes aligned after filtering rows", () => {
		const file = join(tempDir, "v1-compaction.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					id: "v1-compaction",
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({ type: "not_a_real_type", timestamp: "2025-01-01T00:00:01.000Z" }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:02.000Z",
					message: { role: "user", content: "kept", timestamp: 2 },
				}),
				JSON.stringify({
					type: "compaction",
					timestamp: "2025-01-01T00:00:03.000Z",
					summary: "invalid compaction",
					firstKeptEntryIndex: 999,
					tokensBefore: 10,
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:04.000Z",
					message: { role: "user", content: "kept after invalid compaction", timestamp: 4 },
				}),
				JSON.stringify({
					type: "compaction",
					timestamp: "2025-01-01T00:00:05.000Z",
					summary: "valid compaction",
					firstKeptEntryIndex: 4,
					tokensBefore: 20,
				}),
			].join("\n")}\n`,
		);

		const mgr = SessionManager.open(file, tempDir);
		const entries = mgr.getEntries();
		const compactions = entries.filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		const keptMessage = entries.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				entry.message.content === "kept after invalid compaction",
		);
		expect(compactions[0]?.type).toBe("compaction");
		if (compactions[0]?.type === "compaction") {
			expect(compactions[0].firstKeptEntryId).toBe(keptMessage?.id);
		}
	});

	it("drops entries with an unknown type and garbage rows", () => {
		const file = join(tempDir, "unknown-type.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "s2",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "ok", timestamp: 1 },
				}),
				// Unknown type: would be indexed and surfaced by getTree/getEntries.
				JSON.stringify({
					type: "not_a_real_type",
					id: "bad",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:02.000Z",
				}),
				// Known types with incomplete payloads must be rejected too.
				JSON.stringify({
					type: "message",
					id: "partial-message",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:03.000Z",
					message: { role: "user" },
				}),
				JSON.stringify({
					type: "compaction",
					id: "partial-compaction",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:04.000Z",
					summary: "missing firstKeptEntryId",
					tokensBefore: 10,
				}),
				// Garbage row with no type at all.
				JSON.stringify({ foo: "bar", id: "garbage" }),
			].join("\n")}\n`,
		);

		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2); // header + u1
		expect(entries.find((e) => (e as { id?: string }).id === "bad")).toBeUndefined();
		expect(entries.find((e) => (e as { id?: string }).id === "partial-message")).toBeUndefined();
		expect(entries.find((e) => (e as { id?: string }).id === "partial-compaction")).toBeUndefined();
		expect(entries.find((e) => (e as { id?: string }).id === "garbage")).toBeUndefined();

		const mgr = SessionManager.open(file, tempDir);
		expect(mgr.getEntries()).toHaveLength(1);
		expect(mgr.getEntries()[0]!.id).toBe("u1");
		expect(mgr.getTree()).toHaveLength(1);
	});

	it("still loads v1 entries that lack id/parentId before migration backfills them", () => {
		const file = join(tempDir, "v1.jsonl");
		writeFileSync(
			file,
			`${[
				// v1 header: no version field.
				JSON.stringify({
					type: "session",
					id: "v1",
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				}),
				// v1 message entry: no id/parentId. Migration must backfill them.
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", content: "legacy", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);

		const mgr = SessionManager.open(file, tempDir);
		const entries = mgr.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.type).toBe("message");
		expect(typeof entries[0]!.id).toBe("string");
		expect(entries[0]!.parentId).toBeNull();
		const ctx = mgr.buildSessionContext();
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0]!.role).toBe("user");
	});

	it("preserves legacy messages with omitted or null content", () => {
		const file = join(tempDir, "v1-empty-content.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					id: "v1-empty-content",
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:02.000Z",
					message: {
						role: "assistant",
						content: null,
						api: "anthropic-messages",
						provider: "anthropic",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:03.000Z",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "test",
						content: null,
						isError: false,
						timestamp: 3,
					},
				}),
			].join("\n")}\n`,
		);

		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(4);
		expect((entries[1] as { message: { content: unknown } }).message.content).toEqual([]);
		expect((entries[2] as { message: { content: unknown } }).message.content).toEqual([]);
		expect((entries[3] as { message: { content: unknown } }).message.content).toEqual([]);
		expect((entries[2] as { message: { usage: { totalTokens: number } } }).message.usage.totalTokens).toBe(0);

		const mgr = SessionManager.open(file, tempDir);
		expect(mgr.buildSessionContext().messages).toHaveLength(3);
	});

	it("counts assistant thinking and tool-call blocks in session metadata", async () => {
		const file = join(tempDir, "structured-assistant.jsonl");
		writeFileSync(
			file,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "structured-assistant",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "assistant-1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "planning" },
							{ type: "toolCall", id: "call-1", name: "test", arguments: {} },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "test",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 1,
					},
				}),
				JSON.stringify({
					type: "message",
					id: "bash-1",
					parentId: "assistant-1",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: {
						role: "bashExecution",
						command: "printf hello",
						output: "hello",
						exitCode: 0,
						timestamp: 2,
					},
				}),
			].join("\n")}\n`,
		);

		await expect(readSessionInfo(file)).resolves.toMatchObject({ messageCount: 2 });
	});
});

describe("SessionManager _appendEntryWithRollback re-entrant listener (M18)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-rollback-reentrant-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rolls back the caller's entry, not a re-entrant listener's entry, when persist fails after notify", () => {
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const mgr = SessionManager.create(tempDir, sessionDir);

		// Establish a flushed session with an assistant so _persist takes the
		// appendFileSync + notify path (which lets the listener run re-entrantly).
		mgr.appendMessage(userMsg("seed"));
		mgr.appendMessage(assistantMsg("seed reply"));
		const seededLeaf = mgr.getLeafId();
		const seededCount = mgr.getEntries().length;

		// Re-entrant listener: appends one message the first time it is notified.
		let reentered = false;
		const off = mgr.onPersist(() => {
			if (reentered) return;
			reentered = true;
			mgr.appendMessage(userMsg("reentrant"));
		});

		const internals = mgr as unknown as {
			_persist: (entry: unknown) => void;
		};
		const realPersist = internals._persist.bind(mgr) as (entry: unknown) => void;
		let depth = 0;
		// Throw only for the outer (depth 0) persist call, after the listener has
		// had a chance to append re-entrantly. Inner calls delegate normally.
		internals._persist = (entry: unknown) => {
			depth++;
			try {
				realPersist(entry);
			} finally {
				depth--;
			}
			if (depth === 0) throw new Error("persist failed after notify");
		};

		try {
			expect(() => mgr.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).toThrow(
				"persist failed after notify",
			);

			// The caller's custom_message entry must be rolled back, while the
			// listener's entry must remain indexed instead of being popped.
			expect(mgr.getEntries().some((e) => e.type === "custom_message")).toBe(false);
			const entries = mgr.getEntries();
			expect(entries).toHaveLength(seededCount + 1);
			const listenerEntry = entries.at(-1);
			expect(listenerEntry?.type).toBe("message");
			if (listenerEntry?.type === "message" && listenerEntry.message.role === "user") {
				expect(listenerEntry.message.content).toBe("reentrant");
				expect(listenerEntry.parentId).toBe(seededLeaf);
				expect(mgr.getLeafId()).toBe(listenerEntry.id);
			}

			// The session context must retain the listener's successful append.
			const ctx = mgr.buildSessionContext();
			expect(ctx.messages).toHaveLength(seededCount + 1);
			expect(ctx.messages.at(-1)).toMatchObject({ role: "user", content: "reentrant" });
		} finally {
			internals._persist = realPersist;
			off();
		}
	});
});
