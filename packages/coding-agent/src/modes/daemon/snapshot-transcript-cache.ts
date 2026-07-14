import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SnapshotTransferCancelledError } from "./snapshot-transfer-controller.js";

export const SNAPSHOT_TARGET_CHUNK_BYTES = 512 * 1024;
export const SNAPSHOT_MEMORY_CACHE_BYTES = 4 * 1024 * 1024;

interface SnapshotTranscriptChunk {
	buffer?: Buffer;
	path?: string;
}

export type SnapshotTranscriptState = "open" | "complete" | "failed" | "disposed";

export interface SnapshotTranscriptIdentity {
	activeSessionId: string;
	snapshotId: string;
	sessionId: string;
	messageCount: number;
	targetChunkBytes: number;
	eventGeneration: string;
	eventSequence: number;
	transcriptRevision: string;
}

export interface SnapshotTranscriptFingerprint extends SnapshotTranscriptIdentity {
	chunkCount: number;
}

export interface SnapshotTranscriptCacheOptions {
	activeSessionId: string;
	snapshotId: string;
	messages?: readonly AgentMessage[];
	cacheRoot: string;
	targetChunkBytes?: number;
	memoryCacheBytes?: number;
	identity?: SnapshotTranscriptIdentity;
}

interface SnapshotChunkWaiter {
	resolve: (buffer: Buffer | undefined) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

export class SnapshotTranscriptCache {
	private readonly chunks: SnapshotTranscriptChunk[] = [];
	private cacheDirectory?: string;
	private totalBytes = 0;
	private currentState: SnapshotTranscriptState = "open";
	private completedFingerprint?: SnapshotTranscriptFingerprint;
	private readers = 0;
	private disposeRequested = false;
	private failure?: Error;
	private readonly chunkWaiters = new Map<number, SnapshotChunkWaiter[]>();
	readonly targetChunkBytes: number;
	readonly snapshotId: string;
	readonly activeSessionId: string;
	readonly identity?: SnapshotTranscriptIdentity;

	constructor(private readonly options: SnapshotTranscriptCacheOptions) {
		this.targetChunkBytes = options.targetChunkBytes ?? SNAPSHOT_TARGET_CHUNK_BYTES;
		this.snapshotId = options.snapshotId;
		this.activeSessionId = options.activeSessionId;
		this.identity = options.identity ? Object.freeze({ ...options.identity }) : undefined;
		if (
			this.identity &&
			(this.identity.activeSessionId !== this.activeSessionId ||
				this.identity.snapshotId !== this.snapshotId ||
				this.identity.targetChunkBytes !== this.targetChunkBytes)
		) {
			throw new Error(`Snapshot transcript ${this.snapshotId} has inconsistent identity metadata`);
		}
		if (options.messages) {
			this.encodeMessages(options.messages);
			this.markComplete(this.chunks.length);
		}
	}

	get state(): SnapshotTranscriptState {
		return this.currentState;
	}

	get fingerprint(): SnapshotTranscriptFingerprint | undefined {
		return this.completedFingerprint;
	}

	get chunkCount(): number {
		return this.chunks.length;
	}

	get bytes(): number {
		return this.totalBytes;
	}

	get fileBacked(): boolean {
		return this.cacheDirectory !== undefined;
	}

	readChunk(index: number): Buffer {
		if (this.currentState === "disposed") {
			throw new Error(`Snapshot transcript ${this.snapshotId} was disposed`);
		}
		const chunk = this.chunks[index];
		if (!chunk) {
			throw new Error(`Unknown snapshot transcript chunk: ${index}`);
		}
		if (chunk.buffer) {
			return chunk.buffer;
		}
		if (!chunk.path) {
			throw new Error(`Snapshot transcript chunk ${index} has no backing storage`);
		}
		return readFileSync(chunk.path);
	}

	appendEncodedChunk(buffer: Buffer): void {
		if (this.currentState !== "open") {
			throw new Error(`Snapshot transcript ${this.snapshotId} is ${this.currentState}`);
		}
		this.storeChunk(buffer);
	}

	markComplete(chunkCount = this.chunks.length): void {
		if (chunkCount !== this.chunks.length) {
			throw new Error(
				`Snapshot transcript ${this.snapshotId} ended with ${this.chunks.length} of ${chunkCount} chunks`,
			);
		}
		if (this.currentState === "complete") {
			if (this.completedFingerprint && this.completedFingerprint.chunkCount !== chunkCount) {
				throw new Error(`Snapshot transcript ${this.snapshotId} completed with a different chunk count`);
			}
			return;
		}
		if (this.currentState !== "open") {
			throw new Error(`Snapshot transcript ${this.snapshotId} cannot complete from ${this.currentState}`);
		}
		this.currentState = "complete";
		if (this.identity) {
			this.completedFingerprint = Object.freeze({ ...this.identity, chunkCount });
		}
		for (const [index, waiters] of this.chunkWaiters) {
			if (index < this.chunks.length) {
				continue;
			}
			for (const waiter of waiters) {
				waiter.cleanup();
				waiter.resolve(undefined);
			}
			this.chunkWaiters.delete(index);
		}
	}

	markFailed(error: Error): void {
		if (this.currentState === "disposed") {
			return;
		}
		if (this.currentState === "failed") {
			return;
		}
		this.currentState = "failed";
		this.failure = error;
		for (const waiters of this.chunkWaiters.values()) {
			for (const waiter of waiters) {
				waiter.cleanup();
				waiter.reject(error);
			}
		}
		this.chunkWaiters.clear();
	}

	waitForChunk(index: number, signal?: AbortSignal): Promise<Buffer | undefined> {
		if (signal?.aborted) {
			return Promise.reject(snapshotAbortError(signal));
		}
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		if (this.currentState === "disposed") {
			return Promise.reject(new Error(`Snapshot transcript ${this.snapshotId} was disposed`));
		}
		if (index < this.chunks.length) {
			try {
				return Promise.resolve(this.readChunk(index));
			} catch (error) {
				return Promise.reject(error);
			}
		}
		if (this.currentState === "complete") {
			return Promise.resolve(undefined);
		}
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				const waiters = this.chunkWaiters.get(index);
				if (waiters) {
					const remaining = waiters.filter((candidate) => candidate !== waiter);
					if (remaining.length > 0) {
						this.chunkWaiters.set(index, remaining);
					} else {
						this.chunkWaiters.delete(index);
					}
				}
				waiter.cleanup();
				reject(snapshotAbortError(signal));
			};
			const waiter: SnapshotChunkWaiter = {
				resolve,
				reject,
				cleanup: () => signal?.removeEventListener("abort", onAbort),
			};
			const waiters = this.chunkWaiters.get(index) ?? [];
			waiters.push(waiter);
			this.chunkWaiters.set(index, waiters);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	retain(): () => void {
		if (this.currentState === "disposed" || this.disposeRequested) {
			throw new Error(`Snapshot transcript ${this.snapshotId} is being disposed`);
		}
		this.readers++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.readers--;
			if (this.readers === 0 && this.disposeRequested) {
				this.disposeNow();
			}
		};
	}

	dispose(): void {
		if (this.currentState === "disposed" || this.disposeRequested) return;
		this.disposeRequested = true;
		if (this.currentState === "open") {
			this.markFailed(new Error(`Snapshot transcript ${this.snapshotId} was disposed before completion`));
		}
		if (this.readers > 0) return;
		this.disposeNow();
	}

	private disposeNow(): void {
		if (this.currentState === "disposed") return;
		const disposalError = this.failure ?? new Error(`Snapshot transcript ${this.snapshotId} was disposed`);
		for (const waiters of this.chunkWaiters.values()) {
			for (const waiter of waiters) {
				waiter.cleanup();
				waiter.reject(disposalError);
			}
		}
		this.chunkWaiters.clear();
		this.currentState = "disposed";
		this.failure = disposalError;
		if (this.cacheDirectory) {
			rmSync(this.cacheDirectory, { recursive: true, force: true });
			this.cacheDirectory = undefined;
		}
		this.chunks.length = 0;
	}

	private encodeMessages(messages: readonly AgentMessage[]): void {
		let serializedMessages: string[] = [];
		let serializedBytes = 0;
		const flush = () => {
			if (serializedMessages.length === 0) {
				return;
			}
			const index = this.chunks.length;
			const prefix =
				`{"type":"session_snapshot_chunk","activeSessionId":${JSON.stringify(this.options.activeSessionId)},` +
				`"snapshotId":${JSON.stringify(this.options.snapshotId)},"index":${index},"messages":[`;
			const line = Buffer.from(`${prefix}${serializedMessages.join(",")}]}\n`);
			this.storeChunk(line);
			serializedMessages = [];
			serializedBytes = 0;
		};

		for (const message of messages) {
			const serialized = JSON.stringify(message);
			const bytes = Buffer.byteLength(serialized) + (serializedMessages.length > 0 ? 1 : 0);
			if (serializedMessages.length > 0 && serializedBytes + bytes > this.targetChunkBytes) {
				flush();
			}
			serializedMessages.push(serialized);
			serializedBytes += bytes;
		}
		flush();
	}

	private storeChunk(buffer: Buffer): void {
		this.totalBytes += buffer.length;
		const memoryLimit = this.options.memoryCacheBytes ?? SNAPSHOT_MEMORY_CACHE_BYTES;
		if (!this.cacheDirectory && this.totalBytes > memoryLimit) {
			this.cacheDirectory = join(this.options.cacheRoot, this.options.snapshotId.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));
			mkdirSync(this.cacheDirectory, { recursive: true, mode: 0o700 });
			for (let index = 0; index < this.chunks.length; index++) {
				const existing = this.chunks[index]!;
				if (!existing.buffer) {
					continue;
				}
				const path = join(this.cacheDirectory, `${index}.jsonl`);
				writeFileSync(path, existing.buffer, { mode: 0o600 });
				this.chunks[index] = { path };
			}
		}

		if (this.cacheDirectory) {
			const path = join(this.cacheDirectory, `${this.chunks.length}.jsonl`);
			writeFileSync(path, buffer, { mode: 0o600 });
			this.chunks.push({ path });
		} else {
			this.chunks.push({ buffer });
		}
		const index = this.chunks.length - 1;
		const waiters = this.chunkWaiters.get(index);
		if (waiters) {
			const stored = this.readChunk(index);
			for (const waiter of waiters) {
				waiter.cleanup();
				waiter.resolve(stored);
			}
			this.chunkWaiters.delete(index);
		}
	}
}

export function snapshotTranscriptIdentitiesEqual(
	left: SnapshotTranscriptIdentity | undefined,
	right: SnapshotTranscriptIdentity | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.activeSessionId === right.activeSessionId &&
		left.snapshotId === right.snapshotId &&
		left.sessionId === right.sessionId &&
		left.messageCount === right.messageCount &&
		left.targetChunkBytes === right.targetChunkBytes &&
		left.eventGeneration === right.eventGeneration &&
		left.eventSequence === right.eventSequence &&
		left.transcriptRevision === right.transcriptRevision
	);
}

function snapshotAbortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new SnapshotTransferCancelledError("Snapshot transcript wait was cancelled");
}
