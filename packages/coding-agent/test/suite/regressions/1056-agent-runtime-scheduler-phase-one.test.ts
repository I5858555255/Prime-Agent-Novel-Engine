import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeScheduler } from "../../../src/core/agent-runtime-scheduler.js";
import type { HostRequestHandlers } from "../../../src/core/kernel/index.js";
import { createHarness, type Harness } from "../harness.js";

interface InspectableSchedulerSession {
	_createKernelHostHandlers(): HostRequestHandlers;
}

const cleanupDirectories: string[] = [];
const cleanupHarnesses: Harness[] = [];

afterEach(() => {
	for (const harness of cleanupHarnesses.splice(0)) harness.cleanup();
	for (const directory of cleanupDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSchedulerFixture(now: () => number): {
	scheduler: AgentRuntimeScheduler;
	statePath: string;
	workspacePath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-scheduler-1056-"));
	cleanupDirectories.push(root);
	const workspacePath = join(root, "workspace");
	const statePath = join(root, "state", "scheduler.json");
	return {
		scheduler: new AgentRuntimeScheduler({ workspacePath, runId: "run-1056", statePath, now }),
		statePath,
		workspacePath,
	};
}

describe("issue 1056 agent runtime scheduler phase one", () => {
	it("persists registry state and marks interrupted workers as recovering on reload", () => {
		let now = Date.parse("2026-08-09T00:00:00.000Z");
		const fixture = createSchedulerFixture(() => now);
		fixture.scheduler.registerTask({ id: "task-a", objective: "Implement component A", status: "queued" });
		fixture.scheduler.registerAgent({
			id: "agent-a",
			taskId: "task-a",
			parentAgentId: "parent",
			sessionName: "component-a",
		});
		fixture.scheduler.transitionTask("task-a", "running");
		fixture.scheduler.markAgentRunning("agent-a", "session-a");

		now += 5_000;
		fixture.scheduler.recordAgentHeartbeat("agent-a");
		const heartbeatAt = fixture.scheduler.getAgent("agent-a")?.heartbeatAt;

		now += 5_000;
		const restored = new AgentRuntimeScheduler({
			workspacePath: fixture.workspacePath,
			runId: "run-1056",
			statePath: fixture.statePath,
			now: () => now,
		});

		expect(restored.getAgent("agent-a")).toMatchObject({
			status: "recovering",
			sessionId: "session-a",
			heartbeatAt,
		});
		expect(restored.getTask("task-a")?.status).toBe("running");
		expect(restored.summary()).toMatchObject({
			runId: "run-1056",
			agentCounts: { recovering: 1 },
			activeAgents: [expect.objectContaining({ id: "agent-a", status: "recovering" })],
		});
	});

	it("unblocks DAG nodes only after every dependency is integrated", () => {
		let now = Date.parse("2026-08-09T01:00:00.000Z");
		const { scheduler } = createSchedulerFixture(() => now++);
		scheduler.registerTask({ id: "shared-types", objective: "Update shared types", status: "queued" });
		scheduler.registerTask({
			id: "call-sites",
			objective: "Update call sites",
			dependencies: ["shared-types"],
			status: "queued",
		});

		expect(scheduler.getTaskReadiness("call-sites")).toEqual({
			taskId: "call-sites",
			ready: false,
			blockedBy: ["shared-types"],
		});

		scheduler.transitionTask("shared-types", "running");
		scheduler.transitionTask("shared-types", "completed");
		expect(scheduler.getTaskReadiness("call-sites").ready).toBe(false);

		scheduler.transitionTask("shared-types", "integrating");
		scheduler.transitionTask("shared-types", "integrated");
		expect(scheduler.getTaskReadiness("call-sites")).toEqual({
			taskId: "call-sites",
			ready: true,
			blockedBy: [],
		});
		expect(scheduler.summary()).toMatchObject({
			readyTaskIds: ["call-sites"],
			blockedTaskIds: [],
		});
	});

	it("protects running children from cleanup and requires explicit cancellation", async () => {
		let releaseChild!: () => void;
		let childStarted!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const started = new Promise<void>((resolve) => {
			childStarted = resolve;
		});
		const harness = await createHarness({ persistSession: true });
		cleanupHarnesses.push(harness);
		harness.setResponses([
			async () => {
				childStarted();
				await release;
				return fauxAssistantMessage("late result");
			},
		]);

		const child = await harness.session.runRlmChild("Implement component A", { name: "component-a" });
		await started;
		const handlers = (harness.session as unknown as InspectableSchedulerSession)._createKernelHostHandlers();

		await expect(handlers["rlm.delete_subagent"]?.({ target: child.rlm_child_id })).rejects.toThrow(
			"use rlm.cancel_subagent(...) first",
		);
		await expect(handlers["rlm.scheduler_summary"]?.({})).resolves.toMatchObject({
			taskCounts: { running: 1 },
			agentCounts: { running: 1 },
			activeAgents: [expect.objectContaining({ id: child.rlm_child_id, sessionName: "component-a" })],
		});
		await expect(handlers["rlm.cancel_subagent"]?.({ target: "component-a" })).resolves.toMatchObject({
			outcome: "cancelled",
			subagent: { rlm_child_id: child.rlm_child_id },
		});
		expect(harness.session.getAgentRuntimeSchedulerSummary()).toMatchObject({
			taskCounts: { cancelled: 1 },
			agentCounts: { cancelled: 1 },
			activeAgents: [],
		});

		releaseChild();
		await vi.waitFor(() => expect(harness.session.getRlmChildRunStatus(child.rlm_child_id)).toBeUndefined());
	});
});
