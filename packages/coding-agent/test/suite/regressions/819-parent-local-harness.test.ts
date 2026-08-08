import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import {
	getHarnessStatePath,
	getLocalHarnessStateDir,
	type HarnessEntry,
	type HarnessState,
	loadHarnessState,
	saveHarnessState,
	seedInheritedHarnessState,
} from "../../../src/core/refinement/index.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

function memory(content: string): HarnessEntry {
	const timestamp = new Date().toISOString();
	return {
		id: "coordination",
		kind: "memory",
		title: "Coordination state",
		content,
		path: "task/coordination",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: timestamp,
		updated_at: timestamp,
		version: 1,
	};
}

function stateWith(entry: HarnessEntry): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: { [entry.id]: entry },
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

async function childStateDir(cwd: string, sessionDir: string): Promise<string> {
	let childSessionPath: string | undefined;
	await vi.waitFor(async () => {
		const sessions = await SessionManager.list(cwd, sessionDir);
		childSessionPath = sessions[0]?.path;
		expect(childSessionPath).toBeDefined();
	});
	const manager = SessionManager.open(childSessionPath!, sessionDir);
	const stateDir = getLocalHarnessStateDir(manager.getSessionArtifactDir());
	if (!stateDir) {
		throw new Error("Missing child harness state directory");
	}
	return stateDir;
}

describe("parent-local continual harness inheritance", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.unstubAllEnvs();
	});

	it("gives each RLM child an isolated snapshot from its spawn time", async () => {
		const harness = await createHarness({ persistSession: true, rlmDepth: 0, rlmMaxDepth: 1 });
		harnesses.push(harness);
		vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
		const parentStateDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		if (!parentStateDir) {
			throw new Error("Missing parent harness state directory");
		}
		const parentState = stateWith(memory("Initial parent context"));
		parentState.schema = 7;
		parentState.refinements.push({
			id: "refine_0001",
			trigger: "parent-only history",
			changes: ["created coordination memory"],
			evidence: "parent task",
			outcome: "pending",
			created_at: new Date().toISOString(),
		});
		saveHarnessState(parentStateDir, parentState);
		const childSystemPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				childSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("child done");
			},
			fauxAssistantMessage("child done"),
		]);

		const first = await harness.session.runRlmChild("Read the coordination state", { name: "first-child" });
		const firstStateDir = await childStateDir(harness.tempDir, first.session_dir);
		expect(existsSync(getHarnessStatePath(firstStateDir))).toBe(true);
		const inheritedState = loadHarnessState(firstStateDir, "local");
		const inheritedEntry = inheritedState.entries.memory.coordination;
		expect(inheritedState.schema).toBe(7);
		expect(inheritedEntry?.content).toBe("Initial parent context");
		expect(inheritedEntry?.metadata.inheritance).toMatchObject({
			originSessionId: harness.session.sessionId,
			immediateParentSessionId: harness.session.sessionId,
			inheritedAt: expect.any(String),
			inheritedVersion: 1,
		});
		expect(inheritedState.refinements).toEqual([]);
		await vi.waitFor(() => expect(childSystemPrompts).toHaveLength(1));
		expect(childSystemPrompts[0]).toContain("Initial parent context");

		saveHarnessState(parentStateDir, stateWith(memory("Updated parent context")));
		expect(
			seedInheritedHarnessState(loadHarnessState(parentStateDir, "local"), firstStateDir, harness.session.sessionId),
		).toBe(false);
		const laterChildStateDir = join(harness.tempDir, "later-child-harness");
		expect(
			seedInheritedHarnessState(
				loadHarnessState(parentStateDir, "local"),
				laterChildStateDir,
				harness.session.sessionId,
			),
		).toBe(true);
		expect(loadHarnessState(laterChildStateDir, "local").entries.memory.coordination?.content).toBe(
			"Updated parent context",
		);
		expect(loadHarnessState(firstStateDir, "local").entries.memory.coordination?.content).toBe(
			"Initial parent context",
		);

		const firstState = loadHarnessState(firstStateDir, "local");
		firstState.entries.memory.coordination!.content = "First child context";
		saveHarnessState(firstStateDir, firstState);

		expect(loadHarnessState(parentStateDir, "local").entries.memory.coordination?.content).toBe(
			"Updated parent context",
		);
	});
});
