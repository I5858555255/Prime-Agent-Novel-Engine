import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	SnapshotTranscriptCache,
	type SnapshotTranscriptIdentity,
} from "../src/modes/daemon/snapshot-transcript-cache.js";
import { SnapshotTransferCancelledError } from "../src/modes/daemon/snapshot-transfer-controller.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "snapshot-cache-test-"));
	tempDirs.push(directory);
	return directory;
}

function messages(count: number, chars: number): AgentMessage[] {
	return Array.from({ length: count }, (_, index) => ({
		role: "user" as const,
		content: `${index}:${"x".repeat(chars)}`,
		timestamp: index,
	}));
}

function identity(activeSessionId: string, snapshotId: string): SnapshotTranscriptIdentity {
	return {
		activeSessionId,
		snapshotId,
		sessionId: `session-${activeSessionId}`,
		messageCount: 0,
		targetChunkBytes: 512 * 1024,
		eventGeneration: `generation-${activeSessionId}`,
		eventSequence: 1,
		transcriptRevision: `revision-${snapshotId}`,
	};
}

describe("snapshot transcript cache", () => {
	it("encodes transcript chunks as directly forwardable JSONL", () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-a",
			snapshotId: "snapshot-a",
			messages: messages(5, 80),
			cacheRoot: tempDir(),
			targetChunkBytes: 200,
		});

		expect(cache.chunkCount).toBeGreaterThan(1);
		const decoded = Array.from({ length: cache.chunkCount }, (_, index) =>
			JSON.parse(cache.readChunk(index).toString("utf8")),
		);
		expect(decoded.flatMap((chunk) => chunk.messages)).toEqual(messages(5, 80));
		expect(decoded.map((chunk) => chunk.index)).toEqual(decoded.map((_, index) => index));
		cache.dispose();
	});

	it("moves caches above the memory threshold to files", () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-b",
			snapshotId: "snapshot-b",
			messages: messages(6, 100),
			cacheRoot: tempDir(),
			targetChunkBytes: 180,
			memoryCacheBytes: 300,
		});

		expect(cache.fileBacked).toBe(true);
		expect(cache.readChunk(0).toString("utf8")).toContain('"session_snapshot_chunk"');
		cache.dispose();
	});

	it("streams opaque worker chunks to waiting attachments", async () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-c",
			snapshotId: "snapshot-c",
			cacheRoot: tempDir(),
		});
		const firstChunk = cache.waitForChunk(0);
		const encoded = Buffer.from(
			'{"type":"session_snapshot_chunk","activeSessionId":"active-c","snapshotId":"snapshot-c","index":0,"messages":[]}\n',
		);
		cache.appendEncodedChunk(encoded);
		await expect(firstChunk).resolves.toEqual(encoded);

		const end = cache.waitForChunk(1);
		cache.markComplete();
		await expect(end).resolves.toBeUndefined();
		cache.dispose();
	});

	it("defers disposal until active snapshot readers finish", () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-d",
			snapshotId: "snapshot-d",
			messages: messages(3, 80),
			cacheRoot: tempDir(),
			targetChunkBytes: 150,
		});
		const release = cache.retain();
		const firstChunk = cache.readChunk(0);

		cache.dispose();

		expect(cache.readChunk(0)).toEqual(firstChunk);
		release();
		expect(() => cache.readChunk(0)).toThrow("was disposed");
	});

	it("fails pending readers before deferred disposal and releases exactly once", async () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-e",
			snapshotId: "snapshot-e",
			cacheRoot: tempDir(),
			identity: identity("active-e", "snapshot-e"),
		});
		const release = cache.retain();
		const pending = cache.waitForChunk(1);
		const failure = new Error("encoder failed after begin");

		cache.markFailed(failure);
		cache.dispose();

		await expect(pending).rejects.toBe(failure);
		expect(cache.state).toBe("failed");
		release();
		release();
		expect(cache.state).toBe("disposed");
	});

	it("removes aborted waiters without failing the cache", async () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-f",
			snapshotId: "snapshot-f",
			cacheRoot: tempDir(),
		});
		const controller = new AbortController();
		const pending = cache.waitForChunk(0, controller.signal);
		const cancellation = new SnapshotTransferCancelledError("attachment detached");

		controller.abort(cancellation);

		await expect(pending).rejects.toBe(cancellation);
		expect(cache.state).toBe("open");
		cache.appendEncodedChunk(Buffer.from("chunk"));
		cache.markComplete(1);
		expect(cache.state).toBe("complete");
		cache.dispose();
	});

	it("keeps an immutable fingerprint and completes identical endings idempotently", () => {
		const snapshotIdentity = identity("active-g", "snapshot-g");
		const cache = new SnapshotTranscriptCache({
			activeSessionId: "active-g",
			snapshotId: "snapshot-g",
			cacheRoot: tempDir(),
			identity: snapshotIdentity,
		});
		cache.appendEncodedChunk(Buffer.from("chunk"));

		cache.markComplete(1);
		cache.markComplete(1);

		expect(cache.fingerprint).toEqual({ ...snapshotIdentity, chunkCount: 1 });
		expect(Object.isFrozen(cache.fingerprint)).toBe(true);
		expect(() => cache.appendEncodedChunk(Buffer.from("duplicate"))).toThrow("is complete");
		cache.dispose();
	});
});
