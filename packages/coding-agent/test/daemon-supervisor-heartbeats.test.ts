import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, failure, success } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorHarness {
	workers: Map<string, unknown>;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function worker(lifecycle: "ready" | "recovering", connected = true) {
	return {
		descriptor: { lifecycle },
		...(connected ? { client: {} } : {}),
	};
}

describe("daemon supervisor heartbeat aggregation", () => {
	it("uses the last complete worker snapshot during recovery", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			success(command.id, command.type, {
				heartbeats: [{ job: { id: target === first ? "heartbeat-1" : "heartbeat-2" } }],
			}),
		);

		const initial = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-1",
			type: "heartbeats_list",
		});
		expect(initial).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});

		second.descriptor.lifecycle = "recovering";
		delete second.client;
		const recovered = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(recovered).toMatchObject({
			success: true,
			data: { heartbeats: [{ job: { id: "heartbeat-1" } }, { job: { id: "heartbeat-2" } }] },
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(3);
	});

	it("returns a worker failure instead of a partial catalog", async () => {
		const supervisor = createSupervisorHarness();
		const first = worker("ready");
		const second = worker("ready");
		supervisor.workers.set("first", first);
		supervisor.workers.set("second", second);
		supervisor.forwardToWorker = vi.fn(async (target, command) =>
			target === first
				? success(command.id, command.type, { heartbeats: [] })
				: failure(command.id, command.type, "worker unavailable"),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-2",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({ success: false, error: "worker unavailable" });
		expect(supervisor.forwardToWorker).toHaveBeenCalledTimes(2);
	});

	it("fails rather than returning a partial catalog without a cached snapshot", async () => {
		const supervisor = createSupervisorHarness();
		supervisor.workers.set("ready", worker("ready"));
		supervisor.workers.set("recovering", worker("recovering", false));
		supervisor.forwardToWorker = vi.fn(async (_target, command) =>
			success(command.id, command.type, { heartbeats: [] }),
		);

		const response = await supervisor.handleCommand({} as DaemonSocketClient, {
			id: "list-3",
			type: "heartbeats_list",
		});

		expect(response).toMatchObject({
			success: false,
			error: "Cannot list heartbeats while session worker is recovering",
		});
		expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
	});
});
