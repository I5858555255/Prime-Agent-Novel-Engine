import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonAttachResult } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

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

	it("cancels an in-flight recovery after an intentional stop tombstone", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				rootActiveSessionId: string;
				stopRequestedAt?: string;
			};
			intentionalStop: boolean;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: { workerId: "worker-1", pid: process.pid, rootActiveSessionId: "active-1" },
			intentionalStop: false,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		worker.intentionalStop = true;
		worker.descriptor.stopRequestedAt = new Date().toISOString();
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(worker.recovery).toBeUndefined();
	});

	it("relaunches a worker instead of reconnecting to a reused pid", async () => {
		vi.useFakeTimers();
		type RecoveryWorker = {
			descriptor: {
				workerId: string;
				pid: number;
				processStartId: string;
				rootActiveSessionId: string;
				createCommand: { type: "create" };
			};
			intentionalStop: boolean;
			stopRevision: number;
			recovery?: Promise<void>;
		};
		type RecoveryHarness = {
			workers: Map<string, RecoveryWorker>;
			shuttingDown: boolean;
			connectWorker: ReturnType<typeof vi.fn>;
			recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
			launchWorker: ReturnType<typeof vi.fn>;
			recoverWorker(worker: RecoveryWorker): Promise<void>;
		};
		const worker: RecoveryWorker = {
			descriptor: {
				workerId: "worker-reused-pid",
				pid: process.pid,
				processStartId: "different-process-start",
				rootActiveSessionId: "active-1",
				createCommand: { type: "create" },
			},
			intentionalStop: false,
			stopRevision: 0,
		};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			shuttingDown: false,
			connectWorker: vi.fn(),
			recoverUncertainWorkerOperations: vi.fn(async () => {}),
			launchWorker: vi.fn(async () => worker),
		}) as RecoveryHarness;

		const recovery = supervisor.recoverWorker(worker);
		await vi.advanceTimersByTimeAsync(250);
		await recovery;

		expect(supervisor.connectWorker).not.toHaveBeenCalled();
		expect(supervisor.recoverUncertainWorkerOperations).toHaveBeenCalledWith(worker, false);
		expect(supervisor.launchWorker).toHaveBeenCalledWith(worker.descriptor.createCommand, worker);
	});

	it("ignores malformed persisted worker descriptors", () => {
		const descriptorDir = mkdtempSync(join(tmpdir(), "prime-supervisor-descriptor-test-"));
		try {
			writeFileSync(
				join(descriptorDir, "malformed.json"),
				`${JSON.stringify({
					version: 1,
					supervisorSocketPath: "/tmp/supervisor.sock",
					workerId: "worker-1",
					rootActiveSessionId: "active-1",
				})}\n`,
			);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				descriptorDir,
				socketPath: "/tmp/supervisor.sock",
				workers: new Map(),
				log: vi.fn(),
			}) as {
				workers: Map<string, unknown>;
				loadWorkerDescriptors(): void;
			};

			supervisor.loadWorkerDescriptors();

			expect(supervisor.workers.size).toBe(0);
		} finally {
			rmSync(descriptorDir, { recursive: true, force: true });
		}
	});

	it("seeds compact attach streaming from the in-flight assistant message", async () => {
		const assistant = (text: string): AgentMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		const activeSessionId = "active-1";
		const finalizedMessage = assistant("finalized");
		const streamingMessage = assistant("in flight");
		const summary: SessionSummary = {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "working",
			sessionId: "session-1",
			cwd: "/tmp/project",
			isStreaming: true,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 1,
			pendingMessageCount: 0,
			streamingMessage,
		};
		const result = {
			activeSessionId,
			snapshot: { summary, messages: [finalizedMessage] },
		} as unknown as DaemonAttachResult;
		const worker = {
			descriptor: { workerId: "worker-1", lifecycle: "ready", pid: 1234 },
			summaries: new Map([[activeSessionId, summary]]),
			snapshotCache: new Map([[activeSessionId, result]]),
			snapshotLoads: new Map(),
		};
		const client = {
			id: "client-1",
			capabilities: new Set<string>(),
			supportsExtensionUi: false,
			attachedActiveSessionIds: new Set<string>(),
		};
		const seed = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			workers: new Map([[worker.descriptor.workerId, worker]]),
			clients: new Set([client]),
			streamReconstructor: { seed },
			syncWorkerExtensionUi: vi.fn(async () => {}),
		}) as {
			attachClient(
				client: {
					id: string;
					capabilities: Set<string>;
					supportsExtensionUi: boolean;
					attachedActiveSessionIds: Set<string>;
				},
				command: { type: "attach"; activeSessionId: string },
			): Promise<unknown>;
		};

		await supervisor.attachClient(client, { type: "attach", activeSessionId });

		expect(seed).toHaveBeenCalledWith(activeSessionId, streamingMessage);
	});
});
