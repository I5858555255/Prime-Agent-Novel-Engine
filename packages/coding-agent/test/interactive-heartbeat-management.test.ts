import { describe, expect, it, vi } from "vitest";
import type { AgentCronJob, AgentHeartbeatManagementAction } from "../src/core/cron-jobs.js";
import type { AgentConnectionHeartbeat } from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface HeartbeatManagementHarness {
	agentConnection: {
		manageHeartbeat(
			activeSessionId: string,
			jobId: string,
			action: AgentHeartbeatManagementAction,
		): Promise<AgentCronJob>;
	};
	connectionState: { activeSessionId: string };
	patchConnectionState(patch: { heartbeat: AgentCronJob | null }): void;
	refreshHeartbeatCatalog(): Promise<void>;
	manageHeartbeat(heartbeat: AgentConnectionHeartbeat, action: AgentHeartbeatManagementAction): Promise<void>;
}

function heartbeat(): AgentCronJob {
	return {
		id: "heartbeat-1",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-1",
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "check the session",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 0,
	};
}

describe("interactive heartbeat management", () => {
	it("clears local user-heartbeat state after stopping from the manager", async () => {
		const current = heartbeat();
		const stopped = { ...current, status: "cancelled" as const, nextRunAt: undefined };
		const patches: Array<{ heartbeat: AgentCronJob | null }> = [];
		const harness = Object.create(InteractiveMode.prototype) as HeartbeatManagementHarness;
		harness.connectionState = { activeSessionId: current.activeSessionId };
		harness.agentConnection = {
			manageHeartbeat: vi.fn(async () => stopped),
		};
		harness.patchConnectionState = (patch) => patches.push(patch);
		harness.refreshHeartbeatCatalog = vi.fn(async () => {});

		await harness.manageHeartbeat({ job: current }, "stop");

		expect(patches).toEqual([{ heartbeat: null }]);
		expect(harness.refreshHeartbeatCatalog).toHaveBeenCalledOnce();
	});
});
