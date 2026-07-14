import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
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
	acceptLoadedWorkerSnapshot(worker: SupervisorWorkerHarness, loaded: DaemonAttachResult): DaemonAttachResult;
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

describe("ENG-4602 snapshot transfer containment", () => {
	it("aborts an active transfer before awaiting the catch-up loop that owns it", async () => {
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
			snapshotCatchup: { controller: catchupController, promise: transfer.promise },
		} as unknown as DaemonSocketClient;
		const cancellation = new SnapshotTransferCancelledError("session closed");

		await internals.cancelClientSnapshotWork(client, "active-4602", cancellation);

		expect(catchupController.signal.reason).toBe(cancellation);
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
});
