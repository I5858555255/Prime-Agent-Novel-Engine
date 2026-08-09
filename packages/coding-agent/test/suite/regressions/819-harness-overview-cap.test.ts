import { describe, expect, it } from "vitest";
import {
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
} from "../../../src/core/refinement/index.js";

// Fixture from issue #819: 48 memory entries spread across the alphabet plus one entry that was
// written last, carries the highest version, and whose path sorts near the end. On main the
// overview sorts on [path, title, id] and keeps the first six, so the newest lesson never reaches
// the prompt and the other 43 are reachable only as an anonymous "+43 more" count.
const OLDER_AT = "2026-06-01T00:00:00.000Z";
const NEWEST_AT = "2026-06-02T00:00:00.000Z";
const NEWEST_CONTENT =
	"CRITICAL, just learned: the resolver error is caused by a stale lockfile. Re-resolve from a clean cache.";

function memoryEntry(
	id: string,
	title: string,
	path: string,
	content: string,
	version: number,
	updatedAt: string,
): HarnessEntry {
	return {
		id,
		kind: "memory",
		title,
		content,
		path,
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: OLDER_AT,
		updated_at: updatedAt,
		version,
	};
}

function issue819State(): HarnessState {
	const memory: Record<string, HarnessEntry> = {};
	for (let i = 0; i < 48; i++) {
		const letter = String.fromCharCode(97 + (i % 26));
		const id = `mem-${String(i).padStart(3, "0")}`;
		memory[id] = memoryEntry(
			id,
			`${letter}-lesson-${i}`,
			`memory/${letter}/${letter}-lesson-${i}.md`,
			`Older lesson ${i}. `.repeat(12),
			1,
			OLDER_AT,
		);
	}
	memory["mem-new"] = memoryEntry(
		"mem-new",
		"workspace-resolver-fix",
		"memory/w/workspace-resolver-fix.md",
		NEWEST_CONTENT,
		7,
		NEWEST_AT,
	);
	return {
		schema: 1,
		entries: { prompt: {}, memory, skill: {}, subagent: {} },
		refinements: [],
	};
}

function renderedIds(overview: string): string[] {
	return Array.from(overview.matchAll(/^- \[global:([^\]]+)\]/gm), (match) => match[1]);
}

describe("#819 harness overview cap", () => {
	it("renders the most recently written entry with its content", () => {
		const overview = formatHarnessStateForPrompt(issue819State());

		expect(overview).toContain(
			`- [global:mem-new] workspace-resolver-fix (memory/w/workspace-resolver-fix.md, v7): ${NEWEST_CONTENT}`,
		);
		expect(renderedIds(overview)[0]).toBe("mem-new");
	});

	it("names every stored entry so the model can address it by id", () => {
		const state = issue819State();
		const overview = formatHarnessStateForPrompt(state);
		const ids = renderedIds(overview);

		expect(ids).toHaveLength(49);
		for (const id of Object.keys(state.entries.memory)) {
			expect(overview).toContain(`[global:${id}]`);
		}
		expect(overview).toContain("memory: 49");
		expect(overview).not.toContain("more memory entries");
	});

	it("keeps the full menu under a bounded character budget", () => {
		const overview = formatHarnessStateForPrompt(issue819State());

		// Measured 6,480 characters, against 3,951 on main for six named entries and 15,290 for the
		// same store rendered with every body in full.
		expect(overview.length).toBeLessThan(8_000);
	});

	it("renders the same bytes on every call", () => {
		const state = issue819State();

		expect(formatHarnessStateForPrompt(state)).toBe(formatHarnessStateForPrompt(state));
	});
});
