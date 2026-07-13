import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

interface SupervisorMonitorHarness {
	options: { worker: object };
	clients: Set<{ authenticated: boolean }>;
	shuttingDown: boolean;
	supervisorMonitorTimer?: ReturnType<typeof setTimeout>;
	canConnectToSupervisor: (socketPath: string) => Promise<boolean>;
	launchReplacementSupervisor: (socketPath: string) => Promise<void>;
	scheduleSupervisorAvailabilityCheck: (socketPath: string, delayMs: number) => void;
}

function createHarness(canConnect: () => Promise<boolean>): SupervisorMonitorHarness {
	return Object.assign(Object.create(AgentDaemon.prototype), {
		options: { worker: {} },
		clients: new Set<{ authenticated: boolean }>(),
		shuttingDown: false,
		canConnectToSupervisor: vi.fn(canConnect),
		launchReplacementSupervisor: vi.fn(async () => undefined),
	}) as SupervisorMonitorHarness;
}

describe("daemon worker supervisor monitoring", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not poll a healthy supervisor after the startup check", async () => {
		vi.useFakeTimers();
		const daemon = createHarness(async () => true);

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 1500);
		await vi.advanceTimersByTimeAsync(1500);
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(daemon.canConnectToSupervisor).toHaveBeenCalledOnce();
		expect(daemon.supervisorMonitorTimer).toBeUndefined();
	});

	it("skips socket probes while an authenticated supervisor connection is active", async () => {
		vi.useFakeTimers();
		const daemon = createHarness(async () => true);
		daemon.clients.add({ authenticated: true });

		daemon.scheduleSupervisorAvailabilityCheck("/tmp/supervisor.sock", 0);
		await vi.runAllTimersAsync();

		expect(daemon.canConnectToSupervisor).not.toHaveBeenCalled();
	});
});
