import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon, type SnapshotChunkSourceFactory } from "../../../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonOutbound,
} from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { isDaemonWorkerFrameHeader } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import type { SnapshotTranscriptCache } from "../../../src/modes/daemon/snapshot-transcript-cache.js";
import {
	SnapshotTransferCancelledError,
	SnapshotTransferRegistry,
} from "../../../src/modes/daemon/snapshot-transfer-controller.js";
import { type PrivateFrame, PrivateFrameDecoder } from "../../../src/modes/session-worker/private-framing.js";
import { createHarness } from "../harness.js";

interface SupervisorWorkerHarness {
	descriptor: { lifecycle: "ready"; pid: number };
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	incomingTranscripts: Map<string, unknown>;
	snapshotLoads: Map<string, unknown>;
	snapshotRetries: Map<string, unknown>;
	snapshotGenerations: Map<string, number>;
}

interface SupervisorSnapshotInternals {
	clients: Set<DaemonSocketClient>;
	shuttingDown: boolean;
	acceptLoadedWorkerSnapshot(worker: SupervisorWorkerHarness, loaded: DaemonAttachResult): DaemonAttachResult;
	attachClient(
		client: DaemonSocketClient,
		command: { type: "attach"; activeSessionId: string; capabilities?: string[]; supportsExtensionUi?: boolean },
		signal?: AbortSignal,
	): Promise<{ result: DaemonAttachResult; worker: SupervisorWorkerHarness }>;
	cancelClientSnapshotWork(
		client: DaemonSocketClient,
		activeSessionId: string | undefined,
		reason: Error,
	): Promise<void>;
	detachClient(client: DaemonSocketClient, activeSessionId?: string): Promise<void>;
	reloadWorkerSnapshot(
		client: DaemonSocketClient,
		worker: SupervisorWorkerHarness,
		activeSessionId: string,
		failedTranscript: SnapshotTranscriptCache,
		signal: AbortSignal,
	): Promise<{ result: DaemonAttachResult; worker: SupervisorWorkerHarness }>;
	handlePublicSnapshotTransferError(
		client: DaemonSocketClient,
		activeSessionId: string,
		snapshotId: string,
		error: Error,
		signal: AbortSignal,
	): Promise<void>;
	handleWorkerFrame(worker: SupervisorWorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): Promise<void>;
	queueCatchup(client: DaemonSocketClient, activeSessionId: string, purpose?: "replacement" | "resync"): void;
	scheduleClientCatchup(client: DaemonSocketClient): Promise<void>;
}

interface AgentDaemonSnapshotInternals {
	launchWorkerSnapshotTransfer(
		client: DaemonSocketClient,
		result: DaemonAttachResult,
		messages: readonly AgentMessage[],
		purpose: "attach" | "replacement" | "catchup",
	): Promise<void> | undefined;
	cancelClientSnapshotWork(
		client: DaemonSocketClient,
		activeSessionId: string | undefined,
		reason: Error,
	): Promise<void>;
	handleWorkerSnapshotTransferError(
		client: DaemonSocketClient,
		result: DaemonAttachResult,
		purpose: "attach" | "replacement" | "catchup",
		error: Error,
		signal: AbortSignal,
	): Promise<void>;
	detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): Promise<void>;
	log: (message: string) => void;
}

function createSummary(activeSessionId: string, sessionId: string, messageCount: number): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		sessionId,
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount,
		pendingMessageCount: 0,
	};
}

function createStreamedResult(messages: readonly AgentMessage[]): DaemonAttachResult {
	const activeSessionId = "active-4602";
	const sessionId = "session-4602";
	const lastEventSequence = 7;
	const lastEventCursor = { generation: "generation-4602", sequence: lastEventSequence };
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: createSummary(activeSessionId, sessionId, messages.length),
			state: { activeSessionId, sessionId } as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence,
			lastEventCursor,
		},
		replay: { status: "complete", toSequence: lastEventSequence, toCursor: lastEventCursor },
		lastEventSequence,
		lastEventCursor,
		snapshotStream: {
			id: "snapshot-4602",
			messageCount: messages.length,
			targetChunkBytes: 512 * 1024,
			transcriptRevision: "revision-4602",
		},
		client: { id: "worker", capabilities: ["chunked_snapshot"] },
	};
}

function snapshotFrames(
	result: DaemonAttachResult,
	messages: readonly AgentMessage[],
): {
	begin: Extract<DaemonOutbound, { type: "session_snapshot_begin" }>;
	chunk: Extract<DaemonOutbound, { type: "session_snapshot_chunk" }>;
	end: Extract<DaemonOutbound, { type: "session_snapshot_end" }>;
} {
	const stream = result.snapshotStream!;
	const { messages: _messages, ...snapshot } = result.snapshot;
	return {
		begin: {
			type: "session_snapshot_begin",
			activeSessionId: result.activeSessionId,
			snapshotId: stream.id,
			snapshot,
			messageCount: stream.messageCount,
			targetChunkBytes: stream.targetChunkBytes,
			transcriptRevision: stream.transcriptRevision,
		},
		chunk: {
			type: "session_snapshot_chunk",
			activeSessionId: result.activeSessionId,
			snapshotId: stream.id,
			index: 0,
			messages: [...messages],
		},
		end: {
			type: "session_snapshot_end",
			activeSessionId: result.activeSessionId,
			snapshotId: stream.id,
			chunkCount: 1,
			transcriptRevision: stream.transcriptRevision,
			lastEventSequence: result.lastEventSequence,
			lastEventCursor: result.lastEventCursor,
		},
	};
}

function workerFrame(
	message: DaemonOutbound,
	snapshotPurpose?: "attach" | "replacement" | "catchup",
): PrivateFrame<DaemonWorkerFrameHeader> {
	return {
		header: {
			kind: "outbound",
			outboundType: message.type,
			...("activeSessionId" in message ? { activeSessionId: message.activeSessionId } : {}),
			payloadEncoding: "jsonl",
			...(snapshotPurpose ? { snapshotPurpose } : {}),
		},
		payload: Buffer.from(JSON.stringify(message)),
	};
}

function createWorkerHarness(): SupervisorWorkerHarness {
	return {
		descriptor: { lifecycle: "ready", pid: process.pid },
		snapshotCache: new Map(),
		transcriptCaches: new Map(),
		incomingTranscripts: new Map(),
		snapshotLoads: new Map(),
		snapshotRetries: new Map(),
		snapshotGenerations: new Map(),
	};
}

function createSocketClient(id: string, activeSessionIds: string[] = []): DaemonSocketClient {
	return {
		id,
		socket: new PassThrough() as unknown as Socket,
		attachedActiveSessionIds: new Set(activeSessionIds),
		catchupActiveSessionIds: new Set(),
		backpressured: false,
		authenticated: true,
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(["chunked_snapshot"]),
	};
}

describe("ENG-4602 snapshot transfer containment", () => {
	it("cancels a session transfer without aborting its client-wide catch-up loop", async () => {
		const daemon = new AgentDaemon("/tmp/eng-4602-cancel.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as AgentDaemonSnapshotInternals;
		const registry = new SnapshotTransferRegistry();
		const transfer = registry.launch({
			activeSessionId: "active-4602",
			snapshotId: "snapshot-4602",
			defer: false,
			run: (signal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			onError: vi.fn(),
		});
		const catchupController = new AbortController();
		const client = {
			catchupActiveSessionIds: new Set(["active-4602"]),
			catchupPurposes: new Map([["active-4602", "resync" as const]]),
			snapshotTransfers: registry,
			snapshotCatchup: {
				controller: catchupController,
				promise: transfer.promise,
				activeSessionId: "active-4602",
				cancelledActiveSessionIds: new Set(),
			},
		} as unknown as DaemonSocketClient;
		const cancellation = new SnapshotTransferCancelledError("session closed");

		await internals.cancelClientSnapshotWork(client, "active-4602", cancellation);

		expect(catchupController.signal.aborted).toBe(false);
		expect(client.snapshotCatchup?.cancelledActiveSessionIds).toContain("active-4602");
		expect(transfer.signal.reason).toBe(cancellation);
		expect(registry.get("active-4602")).toBeUndefined();
	});

	it("contains a deferred post-begin encoder rejection and keeps the worker channel usable", async () => {
		const harness = await createHarness();
		const disposeSource = vi.fn();
		try {
			harness.setResponses([fauxAssistantMessage("complete")]);
			await harness.session.prompt("stream this transcript");
			const messages = harness.session.messages;
			const sourceFactory: SnapshotChunkSourceFactory = (options) => ({
				async *chunks() {
					yield Buffer.from(
						JSON.stringify({
							type: "session_snapshot_chunk",
							activeSessionId: options.activeSessionId,
							snapshotId: options.snapshotId,
							index: 0,
							messages: [messages[0]],
						}),
					);
					throw new Error("encoder failed after begin");
				},
				dispose: disposeSource,
			});
			const daemon = new AgentDaemon("/tmp/eng-4602-worker.sock", {
				defaultSessionConfig: { agentDir: harness.tempDir, cwd: harness.tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
				worker: { authenticationToken: "test-token" },
				snapshotChunkSourceFactory: sourceFactory,
			});
			const internals = daemon as unknown as AgentDaemonSnapshotInternals;
			internals.log = vi.fn();
			const socket = new PassThrough();
			const written: Buffer[] = [];
			socket.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
			const client: DaemonSocketClient = {
				id: "supervisor",
				socket: socket as unknown as Socket,
				attachedActiveSessionIds: new Set(["active-4602"]),
				catchupActiveSessionIds: new Set(),
				backpressured: false,
				authenticated: true,
				transport: "private-framed",
				detachInput: () => {},
				supportsExtensionUi: false,
				capabilities: new Set(["chunked_snapshot"]),
			};
			const unhandled = vi.fn();
			process.on("unhandledRejection", unhandled);
			try {
				void internals.launchWorkerSnapshotTransfer(client, createStreamedResult(messages), messages, "attach");
				await vi.waitFor(() => {
					expect(client.snapshotTransfers?.get("active-4602")).toBeUndefined();
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
			} finally {
				process.off("unhandledRejection", unhandled);
			}

			const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
			const decoded = decoder.push(Buffer.concat(written)).map((frame) => ({
				header: frame.header,
				message: JSON.parse(frame.payload.toString("utf8")) as DaemonOutbound,
			}));
			expect(
				decoded.map((frame) => (frame.header.kind === "outbound" ? frame.header.outboundType : undefined)),
			).toEqual(["session_snapshot_begin", "session_snapshot_chunk", "session_snapshot_failed"]);
			expect(decoded.at(-1)?.message).toMatchObject({
				type: "session_snapshot_failed",
				snapshotId: "snapshot-4602",
				error: "encoder failed after begin",
			});
			expect(unhandled).not.toHaveBeenCalled();
			expect(socket.destroyed).toBe(false);
			expect(socket.write("still-alive")).toBe(true);
			expect(disposeSource).toHaveBeenCalledOnce();
			expect(client.snapshotStreaming).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("fails a partial incoming cache before disposal, then accepts an identical same-ID retry", async () => {
		const messages: AgentMessage[] = [{ role: "user", content: "retry me", timestamp: 1 }];
		const result = createStreamedResult(messages);
		const frames = snapshotFrames(result, messages);
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-supervisor.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-supervisor-state",
		}) as unknown as SupervisorSnapshotInternals;
		const worker = createWorkerHarness();
		supervisor.acceptLoadedWorkerSnapshot(worker, result);
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.begin));
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.chunk));
		const transcript = worker.transcriptCaches.get(result.activeSessionId)!;
		const release = transcript.retain();
		const pending = transcript.waitForChunk(1);

		await supervisor.handleWorkerFrame(
			worker,
			workerFrame({
				type: "session_snapshot_failed",
				activeSessionId: result.activeSessionId,
				snapshotId: result.snapshotStream!.id,
				error: "encoder failed after begin",
			}),
		);

		await expect(pending).rejects.toThrow("encoder failed after begin");
		expect(transcript.state).toBe("failed");
		expect(worker.incomingTranscripts.size).toBe(0);
		expect(worker.transcriptCaches.size).toBe(0);
		expect(worker.snapshotCache.size).toBe(0);
		release();
		expect(transcript.state).toBe("disposed");

		supervisor.acceptLoadedWorkerSnapshot(worker, result);
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.begin));
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.chunk));
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.end));
		expect(worker.transcriptCaches.get(result.activeSessionId)?.state).toBe("complete");
		expect(worker.incomingTranscripts.size).toBe(0);
	});

	it("drains an identical completed sequence and evicts a mismatched duplicate", async () => {
		const messages: AgentMessage[] = [{ role: "user", content: "stable", timestamp: 1 }];
		const result = createStreamedResult(messages);
		const frames = snapshotFrames(result, messages);
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-supervisor-duplicate.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-supervisor-duplicate-state",
		}) as unknown as SupervisorSnapshotInternals;
		const worker = createWorkerHarness();
		supervisor.acceptLoadedWorkerSnapshot(worker, result);

		for (const frame of [frames.begin, frames.chunk, frames.end, frames.begin, frames.chunk, frames.end]) {
			await supervisor.handleWorkerFrame(worker, workerFrame(frame));
		}

		const completed = worker.transcriptCaches.get(result.activeSessionId);
		expect(completed?.state).toBe("complete");
		expect(completed?.chunkCount).toBe(1);
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.begin));
		await supervisor.handleWorkerFrame(
			worker,
			workerFrame({ ...frames.chunk, messages: [{ role: "user", content: "mismatch", timestamp: 2 }] }),
		);
		expect(worker.incomingTranscripts.size).toBe(0);
		expect(worker.transcriptCaches.size).toBe(0);
		expect(worker.snapshotCache.size).toBe(0);
	});

	it("requeues a non-chunked replacement after the private snapshot source fails", async () => {
		const messages: AgentMessage[] = [{ role: "user", content: "replacement", timestamp: 1 }];
		const result = createStreamedResult(messages);
		const frames = snapshotFrames(result, messages);
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-supervisor-catchup.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-supervisor-catchup-state",
		}) as unknown as SupervisorSnapshotInternals;
		const worker = createWorkerHarness();
		const client = {
			id: "legacy-client",
			attachedActiveSessionIds: new Set([result.activeSessionId]),
			capabilities: new Set(),
		} as unknown as DaemonSocketClient;
		const queueCatchup = vi.fn();
		const scheduleClientCatchup = vi.fn(async () => {});
		supervisor.clients.add(client);
		supervisor.queueCatchup = queueCatchup;
		supervisor.scheduleClientCatchup = scheduleClientCatchup;

		await supervisor.handleWorkerFrame(worker, workerFrame(frames.begin, "replacement"));
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.chunk, "replacement"));
		await supervisor.handleWorkerFrame(
			worker,
			workerFrame(
				{
					type: "session_snapshot_failed",
					activeSessionId: result.activeSessionId,
					snapshotId: result.snapshotStream!.id,
					error: "replacement encoder failed",
				},
				"replacement",
			),
		);

		expect(queueCatchup).toHaveBeenCalledWith(client, result.activeSessionId, "replacement");
		expect(scheduleClientCatchup).toHaveBeenCalledWith(client);
		expect(worker.incomingTranscripts.size).toBe(0);
		expect(worker.transcriptCaches.size).toBe(0);
	});

	it("cancels backpressured worker and public failure delivery", async () => {
		const result = createStreamedResult([]);
		const workerDaemon = new AgentDaemon("/tmp/eng-4602-worker-failure-delivery.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const workerInternals = workerDaemon as unknown as AgentDaemonSnapshotInternals;
		workerInternals.log = vi.fn();
		const workerClient = createSocketClient("worker-supervisor", [result.activeSessionId]);
		workerClient.transport = "private-framed";
		vi.spyOn(workerClient.socket, "write").mockReturnValue(false);
		const workerController = new AbortController();
		const workerDelivery = workerInternals.handleWorkerSnapshotTransferError(
			workerClient,
			result,
			"attach",
			new Error("encoder failed"),
			workerController.signal,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		workerController.abort(new SnapshotTransferCancelledError("worker client detached"));
		await workerDelivery;
		expect(workerClient.socket.destroyed).toBe(false);

		const supervisor = new DaemonSupervisor("/tmp/eng-4602-public-failure-delivery.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-public-failure-delivery-state",
		}) as unknown as SupervisorSnapshotInternals;
		Object.assign(supervisor, { log: vi.fn() });
		const publicClient = createSocketClient("public", [result.activeSessionId]);
		vi.spyOn(publicClient.socket, "write").mockReturnValue(false);
		const publicController = new AbortController();
		const publicDelivery = supervisor.handlePublicSnapshotTransferError(
			publicClient,
			result.activeSessionId,
			result.snapshotStream!.id,
			new Error("cache read failed"),
			publicController.signal,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		publicController.abort(new SnapshotTransferCancelledError("public client detached"));
		await publicDelivery;
		expect(publicClient.socket.destroyed).toBe(false);
	});

	it("makes exactly one fresh public attempt after a source failure", async () => {
		const result = createStreamedResult([]);
		const identity = {
			activeSessionId: result.activeSessionId,
			snapshotId: result.snapshotStream!.id,
			sessionId: result.snapshot.summary.sessionId,
			messageCount: 0,
			targetChunkBytes: result.snapshotStream!.targetChunkBytes,
			eventGeneration: result.lastEventCursor!.generation,
			eventSequence: result.lastEventSequence,
			transcriptRevision: result.snapshotStream!.transcriptRevision,
		};
		const transcript = { identity } as SnapshotTranscriptCache;
		const worker = createWorkerHarness();
		const client = createSocketClient("retry-client", [result.activeSessionId]);
		const streamSnapshotAttempt = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("cache read failed"))
			.mockResolvedValueOnce(undefined);
		const reloadWorkerSnapshot = vi.fn(async () => ({ worker, result }));
		const getOrCreateTranscriptCache = vi.fn(() => transcript);
		const supervisor = Object.assign(
			new DaemonSupervisor("/tmp/eng-4602-public-retry.sock", {
				defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
				descriptorDir: "/tmp/eng-4602-public-retry-state",
			}),
			{ streamSnapshotAttempt, reloadWorkerSnapshot, getOrCreateTranscriptCache },
		) as unknown as {
			streamSnapshotWithRetry(
				client: DaemonSocketClient,
				worker: SupervisorWorkerHarness,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
				purpose: "attach",
				snapshotId: string,
				signal: AbortSignal,
			): Promise<void>;
		};

		await supervisor.streamSnapshotWithRetry(
			client,
			worker,
			result,
			transcript,
			"attach",
			result.snapshotStream!.id,
			new AbortController().signal,
		);

		expect(streamSnapshotAttempt).toHaveBeenCalledTimes(2);
		expect(reloadWorkerSnapshot).toHaveBeenCalledOnce();
		expect(getOrCreateTranscriptCache).toHaveBeenCalledOnce();
	});

	it("stops waiting for a shared public reload without cancelling it", async () => {
		const result = createStreamedResult([]);
		const worker = createWorkerHarness();
		const client = createSocketClient("reload-client", [result.activeSessionId]);
		let resolveReload!: (value: { worker: SupervisorWorkerHarness; result: DaemonAttachResult }) => void;
		const sharedReload = new Promise<{ worker: SupervisorWorkerHarness; result: DaemonAttachResult }>((resolve) => {
			resolveReload = resolve;
		});
		worker.snapshotRetries.set(result.activeSessionId, sharedReload);
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-cancel-reload.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-cancel-reload-state",
		}) as unknown as SupervisorSnapshotInternals;
		const controller = new AbortController();
		const waiting = supervisor.reloadWorkerSnapshot(
			client,
			worker,
			result.activeSessionId,
			{} as SnapshotTranscriptCache,
			controller.signal,
		);
		const cancellation = new SnapshotTransferCancelledError("client detached during reload");

		controller.abort(cancellation);
		await expect(waiting).rejects.toBe(cancellation);
		resolveReload({ worker, result });
		await expect(sharedReload).resolves.toEqual({ worker, result });
		expect(client.attachedActiveSessionIds).toContain(result.activeSessionId);
	});

	it("keeps a shared worker load alive while a cancelled client stops waiting", async () => {
		const result = createStreamedResult([]);
		let resolveRequest!: (response: { success: true; data: DaemonAttachResult }) => void;
		const response = new Promise<{ success: true; data: DaemonAttachResult }>((resolve) => {
			resolveRequest = resolve;
		});
		const request = vi.fn(() => response);
		const worker = Object.assign(createWorkerHarness(), { client: { request } });
		const summary = result.snapshot.summary;
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-stale-load.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-stale-load-state",
		}) as unknown as SupervisorSnapshotInternals & {
			findWorker: ReturnType<typeof vi.fn>;
		};
		supervisor.findWorker = vi.fn(async () => ({ worker, summary }));
		const cancelledClient = createSocketClient("cancelled-client", [result.activeSessionId]);
		const survivingClient = createSocketClient("surviving-client");
		supervisor.clients.add(cancelledClient);
		supervisor.clients.add(survivingClient);
		const command = {
			type: "attach" as const,
			activeSessionId: result.activeSessionId,
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
		};
		cancelledClient.catchupActiveSessionIds!.add(result.activeSessionId);
		const cancelledCatchup = supervisor.scheduleClientCatchup(cancelledClient);
		const survivingAttach = supervisor.attachClient(survivingClient, command);
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

		await expect(supervisor.detachClient(cancelledClient, result.activeSessionId)).resolves.toBeUndefined();
		await cancelledCatchup;
		resolveRequest({ success: true, data: result });
		await expect(survivingAttach).resolves.toMatchObject({ result: { activeSessionId: result.activeSessionId } });
		await vi.waitFor(() => expect(worker.snapshotLoads.size).toBe(0));

		expect(request).toHaveBeenCalledOnce();
		expect(cancelledClient.attachedActiveSessionIds).not.toContain(result.activeSessionId);
		expect(survivingClient.attachedActiveSessionIds).toContain(result.activeSessionId);
		expect(worker.snapshotCache.has(result.activeSessionId)).toBe(true);
		for (const cache of worker.transcriptCaches.values()) {
			cache.dispose();
		}
	});

	it("detaches session A without awaiting a stalled catch-up for session B", async () => {
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-isolated-detach.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-isolated-detach-state",
		}) as unknown as SupervisorSnapshotInternals;
		const client = createSocketClient("shared-client", ["session-a", "session-b"]);
		let finishCatchup!: () => void;
		const catchupPromise = new Promise<void>((resolve) => {
			finishCatchup = resolve;
		});
		const catchupController = new AbortController();
		client.snapshotCatchup = {
			controller: catchupController,
			promise: catchupPromise,
			activeSessionId: "session-b",
			cancelledActiveSessionIds: new Set(),
		};

		await supervisor.cancelClientSnapshotWork(
			client,
			"session-a",
			new SnapshotTransferCancelledError("session A detached"),
		);

		expect(catchupController.signal.aborted).toBe(false);
		expect(client.snapshotCatchup.cancelledActiveSessionIds).toContain("session-a");
		finishCatchup();
		await catchupPromise;
	});

	it("preserves a concurrent reattach after membership is removed before cancellation", async () => {
		const result = createStreamedResult([]);
		const worker = createWorkerHarness();
		worker.snapshotCache.set(result.activeSessionId, result);
		let finishExtensionSync!: () => void;
		const extensionSync = new Promise<void>((resolve) => {
			finishExtensionSync = resolve;
		});
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-detach-epoch.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-detach-epoch-state",
		}) as unknown as SupervisorSnapshotInternals & {
			findWorker: ReturnType<typeof vi.fn>;
			syncWorkerExtensionUi: ReturnType<typeof vi.fn>;
		};
		supervisor.findWorker = vi.fn(async () => ({ worker, summary: result.snapshot.summary }));
		supervisor.syncWorkerExtensionUi = vi.fn(() => extensionSync);
		const client = createSocketClient("reattach-client");
		supervisor.clients.add(client);
		const command = {
			type: "attach" as const,
			activeSessionId: result.activeSessionId,
			capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
		};
		const staleAttach = supervisor.attachClient(client, command);
		await vi.waitFor(() => expect(client.attachedActiveSessionIds).toContain(result.activeSessionId));

		await supervisor.detachClient(client, result.activeSessionId);
		expect(client.attachedActiveSessionIds).not.toContain(result.activeSessionId);
		const currentAttach = supervisor.attachClient(client, command);
		await vi.waitFor(() => expect(client.attachedActiveSessionIds).toContain(result.activeSessionId));
		finishExtensionSync();

		await expect(staleAttach).rejects.toThrow("superseded");
		await expect(currentAttach).resolves.toMatchObject({ result: { activeSessionId: result.activeSessionId } });
		expect(client.attachedActiveSessionIds).toContain(result.activeSessionId);
	});

	it("preserves a concurrent worker reattach after membership is removed before cancellation", async () => {
		const daemon = new AgentDaemon("/tmp/eng-4602-worker-detach-epoch.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "test-token" },
		});
		const internals = daemon as unknown as AgentDaemonSnapshotInternals;
		const client = createSocketClient("worker-reattach-client", ["session-a"]);
		const state = {
			activeSessionId: "session-a",
			clients: new Set([client]),
			extensionUiRequests: new Map(),
		} as unknown as ActiveSessionState;
		let finishCancellation!: () => void;
		const cancellation = new Promise<void>((resolve) => {
			finishCancellation = resolve;
		});
		const cancelClientSnapshotWork = vi.fn(() => cancellation);
		Object.assign(internals, { cancelClientSnapshotWork });

		const detaching = internals.detachClientFromSession(client, state);
		expect(client.attachedActiveSessionIds).not.toContain("session-a");
		expect(state.clients).not.toContain(client);
		client.attachedActiveSessionIds.add("session-a");
		state.clients.add(client);
		finishCancellation();
		await detaching;

		expect(cancelClientSnapshotWork).toHaveBeenCalledOnce();
		expect(client.attachedActiveSessionIds).toContain("session-a");
		expect(state.clients).toContain(client);
	});

	it("does not reschedule catch-up work after terminal shutdown begins", async () => {
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-shutdown-catchup.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-shutdown-catchup-state",
		}) as unknown as SupervisorSnapshotInternals & {
			catchUpClient: ReturnType<typeof vi.fn>;
		};
		const client = createSocketClient("shutdown-client", ["session-a"]);
		client.catchupActiveSessionIds!.add("session-a");
		let rejectCatchup!: (error: Error) => void;
		const catchUpClient = vi.fn(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectCatchup = reject;
				}),
		);
		supervisor.catchUpClient = catchUpClient;
		const scheduled = supervisor.scheduleClientCatchup(client);
		supervisor.shuttingDown = true;
		client.snapshotWorkClosed = true;
		rejectCatchup(new SnapshotTransferCancelledError("supervisor shutdown"));
		await scheduled;
		await supervisor.scheduleClientCatchup(client);

		expect(catchUpClient).toHaveBeenCalledOnce();
		expect(client.snapshotCatchup).toBeUndefined();
	});

	it("accepts matching snapshot frames without an event cursor", async () => {
		const messages: AgentMessage[] = [{ role: "user", content: "cursor optional", timestamp: 1 }];
		const withCursor = createStreamedResult(messages);
		const { lastEventCursor: _snapshotCursor, ...snapshot } = withCursor.snapshot;
		const { lastEventCursor: _resultCursor, ...resultWithoutCursor } = withCursor;
		const result: DaemonAttachResult = {
			...resultWithoutCursor,
			snapshot,
			replay: { status: "complete", toSequence: withCursor.lastEventSequence },
		};
		const frames = snapshotFrames(result, messages);
		const { lastEventCursor: _endCursor, ...end } = frames.end;
		const supervisor = new DaemonSupervisor("/tmp/eng-4602-optional-cursor.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: "/tmp/eng-4602-optional-cursor-state",
		}) as unknown as SupervisorSnapshotInternals;
		const worker = createWorkerHarness();
		supervisor.acceptLoadedWorkerSnapshot(worker, result);

		await supervisor.handleWorkerFrame(worker, workerFrame(frames.begin));
		await supervisor.handleWorkerFrame(worker, workerFrame(frames.chunk));
		await supervisor.handleWorkerFrame(worker, workerFrame(end));

		expect(worker.transcriptCaches.get(result.activeSessionId)?.state).toBe("complete");
		expect(worker.incomingTranscripts.size).toBe(0);
		worker.transcriptCaches.get(result.activeSessionId)?.dispose();
	});
});
