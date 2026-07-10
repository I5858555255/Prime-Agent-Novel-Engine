import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearOrphanProcessJournal,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcessPids,
	recordOrphanProcessState,
} from "../src/core/orphan-process-journal.js";

const tempDirs: string[] = [];
const originalJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

afterEach(() => {
	if (originalJournalPath === undefined) {
		delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	} else {
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = originalJournalPath;
	}
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("orphan process journal", () => {
	it("retains only detached processes still active for the crashed owner", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-orphan-journal-test-"));
		tempDirs.push(directory);
		const path = join(directory, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = path;

		recordOrphanProcessState(12_345, true);
		recordOrphanProcessState(12_346, true);
		recordOrphanProcessState(12_346, false);

		expect(readActiveOrphanProcessPids(path, process.pid)).toEqual([12_345]);
		expect(readActiveOrphanProcessPids(path, process.pid + 1)).toEqual([]);
		clearOrphanProcessJournal(path);
		expect(existsSync(path)).toBe(false);
	});
});
