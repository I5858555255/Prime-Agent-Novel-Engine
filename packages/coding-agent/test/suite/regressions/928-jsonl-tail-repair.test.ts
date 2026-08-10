import { appendFileSync, type chmodSync, type chownSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

type AppendFileSync = typeof appendFileSync;
type ChmodSync = typeof chmodSync;
type ChownSync = typeof chownSync;

const fsMocks = vi.hoisted(() => ({
	actualAppendFileSync: undefined as AppendFileSync | undefined,
	actualChmodSync: undefined as ChmodSync | undefined,
	actualChownSync: undefined as ChownSync | undefined,
	appendFileSync: vi.fn<AppendFileSync>(),
	chmodSync: vi.fn<ChmodSync>(),
	chownSync: vi.fn<ChownSync>(),
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.actualAppendFileSync = actual.appendFileSync;
	fsMocks.actualChmodSync = actual.chmodSync;
	fsMocks.actualChownSync = actual.chownSync;
	fsMocks.appendFileSync.mockImplementation(actual.appendFileSync);
	fsMocks.chmodSync.mockImplementation(actual.chmodSync);
	fsMocks.chownSync.mockImplementation(actual.chownSync);
	return {
		...actual,
		appendFileSync: fsMocks.appendFileSync,
		chmodSync: fsMocks.chmodSync,
		chownSync: fsMocks.chownSync,
	};
});

import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

describe("issue #928 incomplete JSONL tail repair", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		fsMocks.appendFileSync.mockReset();
		fsMocks.appendFileSync.mockImplementation(fsMocks.actualAppendFileSync!);
		fsMocks.chmodSync.mockReset();
		fsMocks.chmodSync.mockImplementation(fsMocks.actualChmodSync!);
		fsMocks.chownSync.mockReset();
		fsMocks.chownSync.mockImplementation(fsMocks.actualChownSync!);
		vi.restoreAllMocks();
	});

	async function createPersistedHarness(): Promise<{ harness: Harness; sessionFile: string }> {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("before crash")]);
		await harness.session.prompt("persist a valid turn");
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return { harness, sessionFile };
	}

	function expectAllRowsValid(sessionFile: string): void {
		for (const row of readFileSync(sessionFile, "utf8").split("\n")) {
			if (row) expect(() => JSON.parse(row)).not.toThrow();
		}
	}

	it("discards a terminal record torn in the middle of a UTF-8 sequence", async () => {
		const { harness, sessionFile } = await createPersistedHarness();
		const validBytes = readFileSync(sessionFile);
		const tailPrefix = Buffer.from('{"type":"custom","data":"');
		const partialCodePoint = Buffer.from("🙂").subarray(0, 2);
		const tornTail = Buffer.concat([tailPrefix, partialCodePoint]);
		appendFileSync(sessionFile, tornTail);

		const resumed = SessionManager.open(sessionFile);

		expect(resumed.getFileRecovery()).toBeUndefined();
		expect(readFileSync(sessionFile)).toEqual(Buffer.concat([validBytes, tornTail]));
		resumed.appendCustomEntry("after_recovery", { source: "mid-utf8" });
		expect(resumed.getFileRecovery()).toEqual({
			action: "truncated_incomplete_tail",
			originalSize: validBytes.length + tailPrefix.length + partialCodePoint.length,
			repairedSize: validBytes.length,
			discardedBytes: tailPrefix.length + partialCodePoint.length,
		});
		expect(readFileSync(sessionFile).subarray(0, validBytes.length)).toEqual(validBytes);
		expect(SessionManager.open(sessionFile).getEntries().at(-1)).toMatchObject({
			type: "custom",
			customType: "after_recovery",
		});
		expect(resumed.getEntries().slice(0, harness.sessionManager.getEntries().length)).toEqual(
			harness.sessionManager.getEntries(),
		);
	});

	it("discards a terminal record torn in the middle of JSON", async () => {
		const { harness, sessionFile } = await createPersistedHarness();
		const validBytes = readFileSync(sessionFile);
		const tornTail = Buffer.from('{"type":"message","id":"torn"');
		appendFileSync(sessionFile, tornTail);

		const resumed = SessionManager.open(sessionFile);

		expect(resumed.getFileRecovery()).toBeUndefined();
		expect(readFileSync(sessionFile)).toEqual(Buffer.concat([validBytes, tornTail]));
		resumed.appendCustomEntry("after_mid_json");
		expect(resumed.getFileRecovery()?.action).toBe("truncated_incomplete_tail");
		expect(resumed.getFileRecovery()?.discardedBytes).toBe(tornTail.length);
		expect(resumed.getEntries().slice(0, harness.sessionManager.getEntries().length)).toEqual(
			harness.sessionManager.getEntries(),
		);
		expect(SessionManager.open(sessionFile).getEntries().at(-1)).toMatchObject({ customType: "after_mid_json" });
	});

	it("terminates and retains a complete final record that lacks a newline", async () => {
		const { harness, sessionFile } = await createPersistedHarness();
		const completeTail = {
			type: "custom",
			customType: "complete_without_newline",
			data: { retained: true },
			id: "complete-tail",
			parentId: harness.sessionManager.getLeafId(),
			timestamp: "2026-08-08T00:00:00.000Z",
		};
		const encodedTail = Buffer.from(JSON.stringify(completeTail));
		appendFileSync(sessionFile, encodedTail);
		const originalSize = readFileSync(sessionFile).length;

		const resumed = SessionManager.open(sessionFile);

		expect(resumed.getFileRecovery()).toBeUndefined();
		expect(readFileSync(sessionFile).length).toBe(originalSize);
		resumed.appendCustomEntry("after_complete_tail");
		expect(resumed.getFileRecovery()).toEqual({
			action: "appended_missing_newline",
			originalSize,
			repairedSize: originalSize + 1,
			discardedBytes: 0,
		});
		expect(readFileSync(sessionFile).at(-1)).toBe(0x0a);
		expect(resumed.getEntry(completeTail.id)).toMatchObject(completeTail);
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getEntry(completeTail.id)).toMatchObject(completeTail);
		expect(reopened.getEntries().at(-1)).toMatchObject({ customType: "after_complete_tail" });
	});

	it("preserves a malformed middle row while repairing the terminal record", async () => {
		const { harness, sessionFile } = await createPersistedHarness();
		const validPrefix = readFileSync(sessionFile);
		const malformedMiddle = Buffer.from("malformed middle row\n");
		const completeTail = Buffer.from(
			JSON.stringify({
				type: "custom",
				customType: "after_malformed_middle",
				id: "after-malformed-middle",
				parentId: harness.sessionManager.getLeafId(),
				timestamp: "2026-08-08T00:00:00.000Z",
			}),
		);
		appendFileSync(sessionFile, Buffer.concat([malformedMiddle, completeTail]));

		const resumed = SessionManager.open(sessionFile);
		const beforeAppend = readFileSync(sessionFile);

		expect(resumed.getFileRecovery()).toBeUndefined();
		expect(beforeAppend).toEqual(Buffer.concat([validPrefix, malformedMiddle, completeTail]));
		resumed.appendCustomEntry("after_malformed_middle_append");
		const repaired = readFileSync(sessionFile);
		expect(resumed.getFileRecovery()?.action).toBe("appended_missing_newline");
		expect(repaired.subarray(0, validPrefix.length)).toEqual(validPrefix);
		expect(repaired.subarray(validPrefix.length, validPrefix.length + malformedMiddle.length)).toEqual(
			malformedMiddle,
		);
		expect(resumed.getEntry("after-malformed-middle")).toBeDefined();
	});

	it("preserves mode without attempting ownership restoration on Windows", async () => {
		const { sessionFile } = await createPersistedHarness();
		appendFileSync(sessionFile, '{"type":"custom","id":"windows-torn"');
		const resumed = SessionManager.open(sessionFile);
		fsMocks.chmodSync.mockClear();
		fsMocks.chownSync.mockClear();
		const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		try {
			resumed.appendCustomEntry("after_windows_recovery");
		} finally {
			platform.mockRestore();
		}

		expect(fsMocks.chownSync).not.toHaveBeenCalled();
		expect(fsMocks.chmodSync).toHaveBeenCalled();
		expect(SessionManager.open(sessionFile).getEntries().at(-1)).toMatchObject({
			customType: "after_windows_recovery",
		});
	});

	it("repairs the source before creating a branch from a resumed torn session", async () => {
		const { harness, sessionFile } = await createPersistedHarness();
		const validBytes = readFileSync(sessionFile);
		const leafId = harness.sessionManager.getLeafId();
		if (!leafId) throw new Error("Expected a persisted session leaf");
		appendFileSync(sessionFile, '{"type":"custom","id":"branch-torn"');
		const resumed = SessionManager.open(sessionFile);

		const branchFile = resumed.createBranchedSession(leafId);

		expect(branchFile).toBeDefined();
		expect(branchFile).not.toBe(sessionFile);
		expect(resumed.getFileRecovery()?.action).toBe("truncated_incomplete_tail");
		expect(readFileSync(sessionFile)).toEqual(validBytes);
		expect(SessionManager.open(branchFile!).getEntries()).toEqual(resumed.getEntries());
	});

	it("reinspects and rewrites after a partial append fails in a live process", async () => {
		const { harness, sessionFile } = await createPersistedHarness();
		const validEntryIds = harness.sessionManager.getEntries().map((entry) => entry.id);
		const resumed = SessionManager.open(sessionFile);
		fsMocks.appendFileSync.mockImplementationOnce((path, data, options) => {
			const partial = Buffer.from(String(data)).subarray(0, 18);
			fsMocks.actualAppendFileSync!(path, partial, options);
			throw new Error("simulated partial append");
		});

		expect(() => resumed.appendCustomEntry("partial_append_attempt")).toThrow("simulated partial append");
		const tornBytes = readFileSync(sessionFile);
		expect(tornBytes.at(-1)).not.toBe(0x0a);

		resumed.appendCustomEntry("retry_after_partial_append");

		expect(resumed.getFileRecovery()?.action).toBe("truncated_incomplete_tail");
		expectAllRowsValid(sessionFile);
		const reopened = SessionManager.open(sessionFile);
		expect(
			reopened
				.getEntries()
				.slice(0, validEntryIds.length)
				.map((entry) => entry.id),
		).toEqual(validEntryIds);
		expect(
			reopened
				.getEntries()
				.slice(-2)
				.map((entry) => (entry.type === "custom" ? entry.customType : undefined)),
		).toEqual(["partial_append_attempt", "retry_after_partial_append"]);
	});

	it("keeps empty-file recovery behavior and permits a subsequent round trip", async () => {
		const { harness } = await createPersistedHarness();
		const sessionFile = join(harness.tempDir, "empty.jsonl");
		writeFileSync(sessionFile, "");

		const resumed = SessionManager.open(sessionFile);

		expect(resumed.getFileRecovery()).toBeUndefined();
		expect(resumed.getHeader()?.type).toBe("session");
		resumed.appendSessionInfo("Recovered empty session");
		expect(SessionManager.open(sessionFile).getSessionName()).toBe("Recovered empty session");
	});

	it("commits the repair before a later append so restart is safe", async () => {
		const { sessionFile } = await createPersistedHarness();
		appendFileSync(sessionFile, '{"type":"custom","id":"interrupted"');
		const interruptedBytes = readFileSync(sessionFile);

		const repaired = SessionManager.open(sessionFile);
		expect(repaired.getFileRecovery()).toBeUndefined();
		expect(readFileSync(sessionFile)).toEqual(interruptedBytes);
		repaired.flushNow();
		expect(repaired.getFileRecovery()?.action).toBe("truncated_incomplete_tail");
		expectAllRowsValid(sessionFile);

		const afterRestart = SessionManager.open(sessionFile);
		expect(afterRestart.getFileRecovery()).toBeUndefined();
		afterRestart.appendCustomEntry("after_restart");
		expect(SessionManager.open(sessionFile).getEntries().at(-1)).toMatchObject({ customType: "after_restart" });
		expectAllRowsValid(sessionFile);
	});
});
