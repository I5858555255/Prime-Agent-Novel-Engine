import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import {
	getGlobalHarnessStateDir,
	type HarnessEntry,
	type HarnessState,
	saveHarnessState,
} from "../../../src/core/refinement/index.js";
import type { ContinualHarnessSettings } from "../../../src/core/settings-manager.js";
import { createHarness, type Harness } from "../harness.js";

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

/** The harness section of a built system prompt, which is what the model actually receives. */
function harnessOverview(systemPrompt: string): string {
	const start = systemPrompt.indexOf("# Continual Harness State");
	expect(start).toBeGreaterThanOrEqual(0);
	return systemPrompt.slice(start);
}

function renderedIds(overview: string): string[] {
	return Array.from(overview.matchAll(/^- \[global:([^\]]+)\]/gm), (match) => match[1]);
}

describe("regression #819: harness overview cap", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = join(tmpdir(), `pi-819-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		saveHarnessState(getGlobalHarnessStateDir(agentDir), issue819State());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function createSession(continualHarness?: ContinualHarnessSettings): Promise<string> {
		const harness = await createHarness(continualHarness ? { settings: { continualHarness } } : {});
		harnesses.push(harness);
		return harnessOverview(harness.session.systemPrompt);
	}

	it("renders the most recently written entry with its content", async () => {
		const overview = await createSession();

		expect(overview).toContain(
			`- [global:mem-new] workspace-resolver-fix (memory/w/workspace-resolver-fix.md, v7): ${NEWEST_CONTENT}`,
		);
		expect(renderedIds(overview)[0]).toBe("mem-new");
	});

	it("names every stored entry so the model can address it by id", async () => {
		const overview = await createSession();
		const ids = renderedIds(overview);

		expect(ids).toHaveLength(49);
		expect(new Set(ids).size).toBe(49);
		expect(overview).toContain("memory: 49");
		expect(overview).not.toContain("more memory entries");
	});

	// The settings key is inert unless AgentSession hands it to buildSystemPrompt, so this asserts
	// the handoff rather than the renderer: without it the defaults render six entries and 43 stubs.
	it("applies continualHarness settings to the session's system prompt", async () => {
		const overview = await createSession({ maxEntriesPerKind: 1, maxContentLength: 40, maxListedEntries: 0 });

		expect(renderedIds(overview)).toEqual(["mem-new"]);
		expect(overview).toContain(`${NEWEST_CONTENT.slice(0, 37)}...`);
		expect(overview).toContain("- +48 more memory entries");
	});

	it("renders the same bytes on every session build", async () => {
		const first = await createSession();
		const again = await createSession();

		expect(again).toBe(first);
	});
});
