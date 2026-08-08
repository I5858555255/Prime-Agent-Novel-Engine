import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageAgentSummary } from "../src/core/agent-messages.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve(value: T): void;
}

interface PeerSyncStats {
	passes: number;
	sends: number;
	catalogRevision: number;
}

interface PeerClient {
	requestWorker: ReturnType<typeof vi.fn>;
}

interface PeerWorker {
	descriptor: {
		workerId: string;
		lifecycle: "ready";
		rootActiveSessionId: string;
		ownerClientId?: string;
	};
	client?: PeerClient;
	summaries: Map<string, SessionSummary>;
}

interface SupervisorPeerSyncInternals {
	workers: Map<string, PeerWorker>;
	shuttingDown: boolean;
	agentPeerSyncStats: PeerSyncStats;
	syncAgentPeers(): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function summary(workerId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	const activeSessionId = `${workerId}-active`;
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: `${workerId}-session`,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function worker(workerId: string, requestWorker?: PeerClient["requestWorker"]): PeerWorker {
	const root = summary(workerId);
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: root.activeSessionId ?? root.id,
		},
		client: {
			requestWorker: requestWorker ?? vi.fn(async () => workerSyncSuccess()),
		},
		summaries: new Map([[root.activeSessionId ?? root.id, root]]),
	};
}

function workerSyncSuccess() {
	return { type: "response" as const, command: "worker_sync_agent_peers", success: true as const };
}

function createSupervisor(workers: readonly PeerWorker[]): SupervisorPeerSyncInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-peer-sync-"));
	tempDirs.push(directory);
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorPeerSyncInternals;
	for (const resident of workers) supervisor.workers.set(resident.descriptor.workerId, resident);
	return supervisor;
}

function sentPeers(client: PeerClient, call: number): AgentSessionMessageAgentSummary[] {
	const command = client.requestWorker.mock.calls[call]?.[0] as
		| { type: "worker_sync_agent_peers"; peers: AgentSessionMessageAgentSummary[] }
		| undefined;
	if (!command) throw new Error(`Missing peer synchronization call ${call}`);
	return command.peers;
}

describe("daemon supervisor peer synchronization", () => {
	it("coalesces a dirty burst into one follow-up pass with linear send count", async () => {
		const firstPassReached = deferred();
		const releaseFirstPass = deferred();
		const residents = Array.from({ length: 12 }, (_, index) =>
			worker(
				`worker-${index}`,
				vi.fn(async () => {
					firstPassReached.resolve();
					await releaseFirstPass.promise;
					return workerSyncSuccess();
				}),
			),
		);
		const supervisor = createSupervisor(residents);

		const initial = supervisor.syncAgentPeers();
		await firstPassReached.promise;
		const burst = Array.from({ length: 100 }, () => supervisor.syncAgentPeers());

		for (const resident of residents) expect(resident.client?.requestWorker).toHaveBeenCalledOnce();
		expect(supervisor.agentPeerSyncStats).toMatchObject({ passes: 1, sends: residents.length });

		releaseFirstPass.resolve();
		await Promise.all([initial, ...burst]);

		expect(supervisor.agentPeerSyncStats).toMatchObject({ passes: 2, sends: residents.length });
		for (const resident of residents) {
			expect(resident.client?.requestWorker).toHaveBeenCalledOnce();
			expect(sentPeers(resident.client!, 0)).toHaveLength(residents.length - 1);
		}
	});

	it("publishes one follow-up snapshot when workers join and leave during a pass", async () => {
		const firstSendReached = deferred();
		const releaseFirstSend = deferred();
		const first = worker(
			"first",
			vi.fn(async () => {
				firstSendReached.resolve();
				await releaseFirstSend.promise;
				return workerSyncSuccess();
			}),
		);
		const leaving = worker("leaving");
		const joining = worker("joining");
		const supervisor = createSupervisor([first, leaving]);

		const initial = supervisor.syncAgentPeers();
		await firstSendReached.promise;
		supervisor.workers.delete(leaving.descriptor.workerId);
		supervisor.workers.set(joining.descriptor.workerId, joining);
		const dirty = supervisor.syncAgentPeers();
		releaseFirstSend.resolve();
		await Promise.all([initial, dirty]);

		expect(sentPeers(first.client!, 0).map((peer) => peer.activeSessionId)).toEqual(["leaving-active"]);
		expect(sentPeers(first.client!, 1).map((peer) => peer.activeSessionId)).toEqual(["joining-active"]);
		expect(leaving.client?.requestWorker).toHaveBeenCalledOnce();
		expect(joining.client?.requestWorker).toHaveBeenCalledOnce();
		expect(supervisor.agentPeerSyncStats).toMatchObject({ passes: 2, sends: 4 });
	});

	it("keeps an in-flight snapshot immutable and sends a changed follow-up payload", async () => {
		const firstSendReached = deferred();
		const releaseFirstSend = deferred();
		const first = worker(
			"first",
			vi.fn(async () => {
				firstSendReached.resolve();
				await releaseFirstSend.promise;
				return workerSyncSuccess();
			}),
		);
		const second = worker("second");
		const supervisor = createSupervisor([first, second]);

		const initial = supervisor.syncAgentPeers();
		await firstSendReached.promise;
		const updated = summary("second", { isStreaming: true, unfinishedActionCount: 2 });
		second.summaries.set(updated.activeSessionId ?? updated.id, updated);
		const dirty = supervisor.syncAgentPeers();
		releaseFirstSend.resolve();
		await Promise.all([initial, dirty]);

		expect(sentPeers(first.client!, 0)[0]).toMatchObject({ isStreaming: false, unfinishedActionCount: 0 });
		expect(sentPeers(first.client!, 1)[0]).toMatchObject({ isStreaming: true, unfinishedActionCount: 2 });
		expect(second.client?.requestWorker).toHaveBeenCalledOnce();
		expect(supervisor.agentPeerSyncStats).toMatchObject({ passes: 2, sends: 3, catalogRevision: 2 });
	});

	it("retries only failed payloads and resends an unchanged catalog after reconnect", async () => {
		const first = worker("first");
		let attempts = 0;
		const second = worker(
			"second",
			vi.fn(async () => {
				attempts++;
				if (attempts === 1) throw new Error("transient peer sync failure");
				return workerSyncSuccess();
			}),
		);
		const supervisor = createSupervisor([first, second]);

		await expect(supervisor.syncAgentPeers()).resolves.toBeUndefined();

		expect(first.client?.requestWorker).toHaveBeenCalledOnce();
		expect(second.client?.requestWorker).toHaveBeenCalledTimes(2);
		expect(supervisor.agentPeerSyncStats).toMatchObject({ passes: 2, sends: 3, catalogRevision: 1 });

		const replacement = vi.fn(async () => workerSyncSuccess());
		second.client = { requestWorker: replacement };
		await supervisor.syncAgentPeers();

		expect(first.client?.requestWorker).toHaveBeenCalledOnce();
		expect(replacement).toHaveBeenCalledOnce();
		expect(supervisor.agentPeerSyncStats).toMatchObject({ passes: 3, sends: 4, catalogRevision: 1 });
	});

	it("does not start or follow up peer synchronization after shutdown begins", async () => {
		const firstSendReached = deferred();
		const releaseFirstSend = deferred();
		const resident = worker(
			"worker",
			vi.fn(async () => {
				firstSendReached.resolve();
				await releaseFirstSend.promise;
				return workerSyncSuccess();
			}),
		);
		const supervisor = createSupervisor([resident]);

		const initial = supervisor.syncAgentPeers();
		await firstSendReached.promise;
		supervisor.shuttingDown = true;
		await supervisor.syncAgentPeers();
		releaseFirstSend.resolve();
		await initial;
		await supervisor.syncAgentPeers();

		expect(resident.client?.requestWorker).toHaveBeenCalledOnce();
		expect(supervisor.agentPeerSyncStats).toMatchObject({ passes: 1, sends: 1 });
	});
});
