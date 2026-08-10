import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeScheduler } from "../../../src/core/agent-runtime-scheduler.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
import { normalizeRequestedRlmResources } from "../../../src/core/rlm-runtime.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const cleanupDirectories: string[] = [];
const cleanupHarnesses: Harness[] = [];

afterEach(() => {
	for (const harness of cleanupHarnesses.splice(0).reverse()) harness.cleanup();
	for (const directory of cleanupDirectories.splice(0).reverse()) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
	}
});

function createSchedulerFixture(
	now: () => number,
	resourceLeaseTtlMs = 1_000,
): {
	scheduler: AgentRuntimeScheduler;
	root: string;
	statePath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-scheduler-1056-p4-"));
	cleanupDirectories.push(root);
	const statePath = join(root, "state", "scheduler.json");
	return {
		scheduler: new AgentRuntimeScheduler({
			workspacePath: root,
			runId: "run-phase-four",
			statePath,
			now,
			resourceLeaseTtlMs,
		}),
		root,
		statePath,
	};
}

function registerResourceTask(scheduler: AgentRuntimeScheduler, id: string, resources: string[]): void {
	scheduler.registerTask({ id, objective: `Run ${id}`, resources, status: "queued" });
	scheduler.registerAgent({ id, taskId: id, sessionName: id });
}

describe("issue 1056 agent runtime scheduler phase four", () => {
	it("atomically rejects competing exclusive resources and records deterministic diagnostics", () => {
		let now = Date.parse("2026-08-10T01:00:00.000Z");
		const { scheduler } = createSchedulerFixture(() => now++);
		const eventTypes: string[] = [];
		scheduler.subscribe((event) => {
			eventTypes.push(event.type);
		});
		registerResourceTask(scheduler, "agent-a", ["database:test", "port:3000"]);
		registerResourceTask(scheduler, "agent-b", ["port:3000"]);

		const first = scheduler.acquireTaskResources("agent-a");
		const repeated = scheduler.acquireTaskResources("agent-a");
		const blocked = scheduler.acquireTaskResources("agent-b");
		expect(first).toMatchObject({ acquired: true, conflicts: [] });
		expect(first.leases.map((lease) => lease.scope)).toEqual(["database:test", "port:3000"]);
		expect(repeated.leases).toEqual(first.leases);
		expect(scheduler.summary().activeResourceLeases).toHaveLength(2);
		expect(blocked).toMatchObject({
			acquired: false,
			leases: [],
			conflicts: [expect.objectContaining({ scope: "port:3000", ownerAgentId: "agent-a" })],
		});
		expect(scheduler.summary()).toMatchObject({
			activeResourceLeases: [
				expect.objectContaining({ scope: "database:test", agentId: "agent-a" }),
				expect.objectContaining({ scope: "port:3000", agentId: "agent-a" }),
			],
			blockedResourceTasks: [expect.objectContaining({ taskId: "agent-b", resources: ["port:3000"] })],
		});

		const released = scheduler.releaseAgentResources("agent-a");
		const acquiredAfterRelease = scheduler.acquireTaskResources("agent-b");
		expect(released).toHaveLength(2);
		expect(acquiredAfterRelease).toMatchObject({
			acquired: true,
			leases: [expect.objectContaining({ scope: "port:3000", epoch: 2 })],
		});
		expect(scheduler.summary().blockedResourceTasks).toEqual([]);
		expect(eventTypes).toContain("resource_acquired");
		expect(eventTypes).toContain("resource_blocked");
		expect(eventTypes).toContain("resource_released");
		const sequences = scheduler.snapshot().events.map((event) => event.sequence);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
	});

	it("renews leases on heartbeat and recovers stale ownership after restart", () => {
		let now = Date.parse("2026-08-10T02:00:00.000Z");
		const fixture = createSchedulerFixture(() => now, 1_000);
		registerResourceTask(fixture.scheduler, "agent-a", ["deployment:staging"]);
		fixture.scheduler.acquireTaskResources("agent-a");
		fixture.scheduler.markAgentRunning("agent-a");
		now += 500;
		fixture.scheduler.recordAgentHeartbeat("agent-a");

		now += 700;
		const restoredBeforeExpiry = new AgentRuntimeScheduler({
			workspacePath: fixture.root,
			runId: "run-phase-four",
			statePath: fixture.statePath,
			now: () => now,
			resourceLeaseTtlMs: 1_000,
		});
		expect(restoredBeforeExpiry.summary().activeResourceLeases).toHaveLength(1);
		expect(restoredBeforeExpiry.getAgent("agent-a")?.status).toBe("recovering");

		now += 400;
		const restoredAfterExpiry = new AgentRuntimeScheduler({
			workspacePath: fixture.root,
			runId: "run-phase-four",
			statePath: fixture.statePath,
			now: () => now,
			resourceLeaseTtlMs: 1_000,
		});
		expect(restoredAfterExpiry.summary().activeResourceLeases).toEqual([]);
		expect(restoredAfterExpiry.snapshot().resourceLeases).toEqual([
			expect.objectContaining({ status: "expired", releaseReason: "lease_expired" }),
		]);
		expect(restoredAfterExpiry.snapshot().events.map((event) => event.type)).toContain("resource_expired");
		registerResourceTask(restoredAfterExpiry, "agent-b", ["deployment:staging"]);
		expect(restoredAfterExpiry.acquireTaskResources("agent-b")).toMatchObject({
			acquired: true,
			leases: [expect.objectContaining({ epoch: 2 })],
		});
	});

	it("migrates persisted phase-three scheduler state without inventing ownership", () => {
		const now = Date.parse("2026-08-10T02:30:00.000Z");
		const fixture = createSchedulerFixture(() => now);
		const current = fixture.scheduler.snapshot();
		writeFileSync(
			fixture.statePath,
			JSON.stringify({
				version: 3,
				workspaceId: current.workspaceId,
				runId: current.runId,
				createdAt: current.createdAt,
				updatedAt: current.updatedAt,
				tasks: [
					{
						id: "legacy-task",
						objective: "Restore the legacy task",
						dependencies: [],
						status: "queued",
						createdAt: current.createdAt,
						updatedAt: current.updatedAt,
					},
				],
				agents: [],
				integrationRecords: [],
				integrationWorkspaces: [],
			}),
		);

		const restored = new AgentRuntimeScheduler({
			workspacePath: fixture.root,
			runId: "run-phase-four",
			statePath: fixture.statePath,
			now: () => now,
		});
		expect(restored.getTask("legacy-task")?.resources).toEqual([]);
		expect(restored.snapshot()).toMatchObject({
			version: 4,
			resourceLeases: [],
			resourceBlocks: [],
			events: [],
			nextEventSequence: 1,
		});
		expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))).toMatchObject({ version: 4 });
	});

	it("injects current ownership into the root orchestrator and rejects a conflicting spawn", async () => {
		let now = Date.parse("2026-08-10T03:00:00.000Z");
		const fixture = createSchedulerFixture(() => now++);
		const parent = await createHarness({ agentRuntimeScheduler: fixture.scheduler });
		cleanupHarnesses.push(parent);
		registerResourceTask(fixture.scheduler, "lease-owner", ["port:4100"]);
		fixture.scheduler.acquireTaskResources("lease-owner");

		const pending = parent.session.getPendingNextTurnMessageSnapshots();
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ customType: "agent_runtime_scheduler_context", display: false });
		expect(getMessageText(pending[0])).toContain("port:4100: lease-owner");
		await expect(
			parent.session.runRlmChild("Start another server", {
				name: "conflicting-server",
				resources: ["port:4100"],
			}),
		).rejects.toThrow("RLM task resource acquisition blocked");
		expect(fixture.scheduler.summary().blockedResourceTasks).toEqual([
			expect.objectContaining({
				agentId: expect.any(String),
				conflicts: [expect.objectContaining({ scope: "port:4100" })],
			}),
		]);
		expect(normalizeRequestedRlmResources([" port:4100 ", "database:test", "port:4100"])).toEqual([
			"database:test",
			"port:4100",
		]);
		expect(() => normalizeRequestedRlmResources(["valid", 3])).toThrow("only strings");
	});

	it("adds leased resource scope to the child task and releases it on completion", async () => {
		let now = Date.parse("2026-08-10T04:00:00.000Z");
		const fixture = createSchedulerFixture(() => now++);
		const child = await createHarness();
		cleanupHarnesses.push(child);
		let runtimeOptions: CreateRlmSubagentRuntimeOptions | undefined;
		const parent = await createHarness({
			agentRuntimeScheduler: fixture.scheduler,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async (options) => {
					runtimeOptions = options;
					return { session: child.session };
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		cleanupHarnesses.push(parent);
		child.setResponses([fauxAssistantMessage("Completed the migration task.")]);

		const handle = await parent.session.runRlmChild("Run migrations", {
			name: "migration-worker",
			resources: ["database:migrations"],
		});
		await vi.waitFor(() => expect(fixture.scheduler.getAgent(handle.rlm_child_id)?.status).toBe("completed"));
		expect(runtimeOptions?.prompt).toBe("Run migrations");
		expect(child.session.messages.map(getMessageText).join("\n")).toContain("exclusive: database:migrations");
		expect(fixture.scheduler.summary().activeResourceLeases).toEqual([]);
		expect(fixture.scheduler.snapshot().resourceLeases).toEqual([
			expect.objectContaining({
				agentId: handle.rlm_child_id,
				status: "released",
				releaseReason: "agent_completed",
			}),
		]);
	});
});
