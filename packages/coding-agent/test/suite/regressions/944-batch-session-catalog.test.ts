import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readSessionInfo,
	SESSION_LIST_METADATA_CONCURRENCY,
	type SessionInfoReadMode,
	SessionManager,
} from "../../../src/core/session-manager.js";
import type { AgentConnectionSavedSessionInfo } from "../../../src/modes/agent-connection/types.js";
import { AgentsViewMode } from "../../../src/modes/agents-view/agents-view-mode.js";
import {
	buildAgentsViewRows,
	getAgentsViewSelectionKey,
	reconcileUnifiedSessions,
	resolveAgentsViewSelectionState,
} from "../../../src/modes/agents-view/agents-view-state.js";
import {
	ProgressiveCatalogBatcher,
	SAVED_CATALOG_BATCH_MAX_DELAY_MS,
	SAVED_CATALOG_BATCH_SIZE,
} from "../../../src/modes/agents-view/progressive-catalog-batcher.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-944-"));
	temporaryDirectories.push(directory);
	return directory;
}

function sessionHeader(id: string, cwd: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	});
}

function userMessage(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	});
}

function writeSession(path: string, id: string, cwd: string, messages: string[] = []): void {
	writeFileSync(path, `${[sessionHeader(id, cwd), ...messages].join("\n")}\n`);
}

function savedSession(index: number, directory: string): AgentConnectionSavedSessionInfo {
	return {
		path: join(directory, `${index}.jsonl`),
		id: `session-${index}`,
		cwd: directory,
		created: new Date(1_000 + index),
		modified: new Date(1_000 + index),
		messageCount: 1,
		firstMessage: `message ${index}`,
		allMessagesText: `message ${index}`,
	};
}

function invokeAgentsView(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...values: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

function serializeSavedSession(session: AgentConnectionSavedSessionInfo): Record<string, unknown> {
	return {
		...session,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
	};
}

afterEach(() => {
	vi.useRealTimers();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("#944 saved-session metadata cache", () => {
	it("reads only a bounded suffix proof and appended bytes after a safe cached boundary", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "append.jsonl");
		writeSession(path, "append", directory, [
			userMessage("filler", "x".repeat(16 * 1024)),
			userMessage("one", "first"),
		]);

		const initialBytes: number[] = [];
		const initialModes: SessionInfoReadMode[] = [];
		expect(
			await readSessionInfo(path, {
				onBytesRead: (bytes) => initialBytes.push(bytes),
				onMode: (mode) => initialModes.push(mode),
			}),
		).toMatchObject({ messageCount: 2 });

		const appended = `${userMessage("two", "second")}\n`;
		appendFileSync(path, appended);
		const appendBytes: number[] = [];
		const appendModes: SessionInfoReadMode[] = [];
		expect(
			await readSessionInfo(path, {
				onBytesRead: (bytes) => appendBytes.push(bytes),
				onMode: (mode) => appendModes.push(mode),
			}),
		).toMatchObject({ messageCount: 3, allMessagesText: expect.stringContaining("second") });

		expect(initialModes).toEqual(["full"]);
		expect(appendModes).toEqual(["append"]);
		expect(appendBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(
			Buffer.byteLength(appended) + 8192,
		);
		expect(appendBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(
			initialBytes.reduce((sum, bytes) => sum + bytes, 0) + Buffer.byteLength(appended),
		);
	});

	it("detects an opening-prefix rewrite that preserves the old append boundary", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "prefix-proof.jsonl");
		writeSession(path, "prefix-aa", directory, [userMessage("one", "x".repeat(16 * 1024))]);
		await readSessionInfo(path);

		const rewritten = readFileSync(path);
		const idOffset = rewritten.indexOf("prefix-aa");
		expect(idOffset).toBeGreaterThanOrEqual(0);
		rewritten.write("prefix-bb", idOffset, "utf8");
		writeFileSync(path, Buffer.concat([rewritten, Buffer.from(`${userMessage("two", "appended")}\n`)]));
		const modes: SessionInfoReadMode[] = [];

		expect(await readSessionInfo(path, { onMode: (mode) => modes.push(mode) })).toMatchObject({
			id: "prefix-bb",
			messageCount: 2,
		});
		expect(modes).toEqual(["full"]);
	});

	it("keeps a verified snapshot visible when the file grows during verification", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "concurrent-append.jsonl");
		writeSession(path, "concurrent-append", directory, [userMessage("one", "first")]);
		await readSessionInfo(path);
		appendFileSync(path, `${userMessage("two", "second")}\n`);

		let grewDuringRead = false;
		const modes: SessionInfoReadMode[] = [];
		const info = await readSessionInfo(path, {
			onBytesRead: () => {
				if (grewDuringRead) return;
				grewDuringRead = true;
				appendFileSync(path, `${userMessage("three", "third")}\n`);
			},
			onMode: (mode) => modes.push(mode),
		});

		expect(info).toMatchObject({ messageCount: 2, allMessagesText: "first second" });
		expect(modes).toEqual(["append"]);
		expect(await readSessionInfo(path)).toMatchObject({
			messageCount: 3,
			allMessagesText: "first second third",
		});
	});

	it("retries growth from an unterminated boundary instead of caching stale metadata", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "unsafe-growth.jsonl");
		writeFileSync(path, `${sessionHeader("unsafe-growth", directory)}\n${userMessage("one", "first")}`);
		let appended = false;
		const modes: SessionInfoReadMode[] = [];

		const info = await readSessionInfo(path, {
			onBytesRead: () => {
				if (appended) return;
				appended = true;
				appendFileSync(path, `${userMessage("two", "second")}\n`);
			},
			onMode: (mode) => modes.push(mode),
		});

		expect(info).toMatchObject({ messageCount: 0, firstMessage: "(no messages)" });
		expect(modes).toEqual(["full"]);
	});

	it("falls back to a full scan for truncation, rewrite, replacement, and prefix mismatch", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "rewritten.jsonl");
		writeSession(path, "original", directory, [userMessage("one", "original message")]);
		await readSessionInfo(path);

		writeSession(path, "short", directory);
		const modes: SessionInfoReadMode[] = [];
		expect(await readSessionInfo(path, { onMode: (mode) => modes.push(mode) })).toMatchObject({ id: "short" });

		writeSession(path, "same-size", directory, [userMessage("one", "rewritten message")]);
		expect(await readSessionInfo(path, { onMode: (mode) => modes.push(mode) })).toMatchObject({
			id: "same-size",
			firstMessage: "rewritten message",
		});

		const replacement = join(directory, "replacement.jsonl");
		writeSession(replacement, "replacement", directory, [userMessage("one", "replacement message")]);
		renameSync(replacement, path);
		expect(await readSessionInfo(path, { onMode: (mode) => modes.push(mode) })).toMatchObject({ id: "replacement" });

		writeSession(path, "prefix-mismatch", directory, [userMessage("one", `changed prefix ${"x".repeat(512)}`)]);
		expect(await readSessionInfo(path, { onMode: (mode) => modes.push(mode) })).toMatchObject({
			id: "prefix-mismatch",
		});
		expect(modes).toEqual(["full", "full", "full", "full"]);
	});

	it("does not resume from a malformed or unterminated tail", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "tail.jsonl");
		writeSession(path, "tail", directory, [userMessage("one", "first")]);
		await readSessionInfo(path);

		appendFileSync(path, "not-json\n");
		const malformedModes: SessionInfoReadMode[] = [];
		expect(await readSessionInfo(path, { onMode: (mode) => malformedModes.push(mode) })).toMatchObject({
			messageCount: 1,
		});

		appendFileSync(path, '{"type":"message"');
		const unterminatedModes: SessionInfoReadMode[] = [];
		expect(await readSessionInfo(path, { onMode: (mode) => unterminatedModes.push(mode) })).toMatchObject({
			messageCount: 1,
		});

		appendFileSync(
			path,
			',"id":"two","parentId":null,"timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"user","content":"recovered","timestamp":2}}\n',
		);
		const recoveredModes: SessionInfoReadMode[] = [];
		expect(await readSessionInfo(path, { onMode: (mode) => recoveredModes.push(mode) })).toMatchObject({
			messageCount: 2,
			allMessagesText: "first recovered",
		});
		expect(malformedModes).toEqual(["full"]);
		expect(unterminatedModes).toEqual(["full"]);
		expect(recoveredModes).toEqual(["full"]);
	});

	it("drops deleted files from direct reads and catalog results", async () => {
		const directory = createTemporaryDirectory();
		const path = join(directory, "deleted.jsonl");
		writeSession(path, "deleted", directory);
		expect(await readSessionInfo(path)).toMatchObject({ id: "deleted" });
		rmSync(path);
		expect(await readSessionInfo(path)).toBeNull();
		expect(await SessionManager.listAll(undefined, directory)).toEqual([]);
	});
});

describe("#944 bounded saved-session ingestion", () => {
	it.each([10, 100, 1000])("keeps %i-file progress linear while bounding metadata reads", async (count) => {
		const directory = createTemporaryDirectory();
		for (let index = 0; index < count; index++) {
			writeSession(join(directory, `${index}.jsonl`), `session-${index}`, directory);
		}
		let activeReads = 0;
		let maximumActiveReads = 0;
		const progress: number[] = [];
		const discovered = new Set<string>();

		const sessions = await SessionManager.listAll(
			{
				onProgress: (loaded, total) => {
					expect(total).toBe(count);
					progress.push(loaded);
				},
				onSession: (session) => discovered.add(session.id),
				diagnostics: {
					onReadStart: () => {
						activeReads += 1;
						maximumActiveReads = Math.max(maximumActiveReads, activeReads);
					},
					onReadEnd: () => {
						activeReads -= 1;
					},
				},
			},
			directory,
		);

		expect(sessions).toHaveLength(count);
		expect(discovered.size).toBe(count);
		expect(progress).toEqual(Array.from({ length: count }, (_, index) => index + 1));
		expect(activeReads).toBe(0);
		expect(maximumActiveReads).toBeGreaterThan(1);
		expect(maximumActiveReads).toBeLessThanOrEqual(SESSION_LIST_METADATA_CONCURRENCY);
	});
});

describe("#944 progressive catalog reconciliation", () => {
	it("integrates count batching with one authoritative final reconciliation", async () => {
		vi.useFakeTimers();
		const directory = createTemporaryDirectory();
		const sessions = Array.from({ length: 100 }, (_, index) => savedSession(index, directory));
		const reconcileCatalogs = vi.fn();
		const request = vi.fn(async (_command: unknown, _timeout: number, options: Record<string, unknown>) => {
			const onProgress = options.onProgress as ((update: Record<string, unknown>) => void) | undefined;
			for (const session of sessions) {
				onProgress?.({
					type: "session_list_item",
					command: "list_saved_sessions",
					session: serializeSavedSession(session),
				});
			}
			return {
				success: true,
				data: { sessions: sessions.map(serializeSavedSession) },
			};
		});
		const self: Record<string, unknown> = {
			reconnectPromise: undefined,
			daemonShutdownReceived: false,
			savedCatalogBatcher: undefined,
			savedCatalogGeneration: 0,
			persistentState: {},
			savedCatalogRefreshPending: false,
			savedCatalogReady: true,
			lastSuccessfulSavedSessions: [],
			stopped: false,
			requireClient: () => ({ request }),
			getSavedSessionCatalogContext: () => ({ cwd: directory }),
			reconcileCatalogs,
			resolveMissingSelectionAnchor: vi.fn(),
		};

		await expect(invokeAgentsView("refreshSavedSessions", self)).resolves.toBe(true);

		expect(reconcileCatalogs).toHaveBeenCalledTimes(Math.floor(100 / SAVED_CATALOG_BATCH_SIZE) + 1);
		expect(self.savedSessions).toEqual(sessions);
		expect((self.persistentState as Record<string, unknown>).savedSessions).toEqual(sessions);
		vi.runAllTimers();
		expect(reconcileCatalogs).toHaveBeenCalledTimes(Math.floor(100 / SAVED_CATALOG_BATCH_SIZE) + 1);
	});

	it("cancels a superseded refresh without publishing its delayed batch", async () => {
		vi.useFakeTimers();
		const directory = createTemporaryDirectory();
		const stale = savedSession(1, directory);
		const fresh = savedSession(2, directory);
		let resolveStale: ((response: Record<string, unknown>) => void) | undefined;
		let requestCount = 0;
		const request = vi.fn((_command: unknown, _timeout: number, options: Record<string, unknown>) => {
			requestCount += 1;
			const onProgress = options.onProgress as ((update: Record<string, unknown>) => void) | undefined;
			if (requestCount === 1) {
				onProgress?.({
					type: "session_list_item",
					command: "list_saved_sessions",
					session: serializeSavedSession(stale),
				});
				return new Promise<Record<string, unknown>>((resolve) => {
					resolveStale = resolve;
				});
			}
			return Promise.resolve({ success: true, data: { sessions: [serializeSavedSession(fresh)] } });
		});
		const reconcileCatalogs = vi.fn();
		const self: Record<string, unknown> = {
			reconnectPromise: undefined,
			daemonShutdownReceived: false,
			savedCatalogBatcher: undefined,
			savedCatalogGeneration: 0,
			persistentState: {},
			savedCatalogRefreshPending: false,
			savedCatalogReady: true,
			lastSuccessfulSavedSessions: [],
			stopped: false,
			requireClient: () => ({ request }),
			getSavedSessionCatalogContext: () => ({ cwd: directory }),
			reconcileCatalogs,
			resolveMissingSelectionAnchor: vi.fn(),
		};

		const first = invokeAgentsView("refreshSavedSessions", self) as Promise<boolean>;
		const second = invokeAgentsView("refreshSavedSessions", self) as Promise<boolean>;
		await expect(second).resolves.toBe(true);
		expect(reconcileCatalogs).toHaveBeenCalledOnce();
		expect(self.savedSessions).toEqual([fresh]);

		vi.runAllTimers();
		resolveStale?.({ success: true, data: { sessions: [serializeSavedSession(stale)] } });
		await expect(first).resolves.toBe(false);
		expect(reconcileCatalogs).toHaveBeenCalledOnce();
		expect(self.savedSessions).toEqual([fresh]);
	});

	it("cancels a delayed saved-catalog batch when the agents view finishes", () => {
		vi.useFakeTimers();
		const reconcile = vi.fn();
		const batcher = new ProgressiveCatalogBatcher({
			maxBatchSize: SAVED_CATALOG_BATCH_SIZE,
			maxDelayMs: SAVED_CATALOG_BATCH_MAX_DELAY_MS,
			onFlush: reconcile,
		});
		batcher.add();
		const self: Record<string, unknown> = {
			stopped: false,
			savedCatalogGeneration: 0,
			savedCatalogBatcher: batcher,
			liveCatalogGeneration: 0,
			heartbeatCatalogGeneration: 0,
			pollTimer: undefined,
			heartbeatPollTimer: undefined,
			animationTimer: undefined,
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			setStatusMessage: vi.fn(),
			ui: { stop: vi.fn() },
			stopThemeWatcher: vi.fn(),
			unsubscribeClientClose: undefined,
			unsubscribeClientMessage: undefined,
			client: undefined,
			resolveRun: vi.fn(),
		};

		invokeAgentsView("finish", self, { type: "exit" });
		vi.runAllTimers();

		expect(reconcile).not.toHaveBeenCalled();
		expect(self.savedCatalogBatcher).toBeUndefined();
	});

	it.each([10, 100, 1000])("bounds %i progressive items by count and emits one final reconciliation", (count) => {
		vi.useFakeTimers();
		const reconcile = vi.fn();
		const batcher = new ProgressiveCatalogBatcher({
			maxBatchSize: SAVED_CATALOG_BATCH_SIZE,
			maxDelayMs: SAVED_CATALOG_BATCH_MAX_DELAY_MS,
			onFlush: reconcile,
		});
		for (let index = 0; index < count; index++) batcher.add();
		const intermediateCount = Math.floor(count / SAVED_CATALOG_BATCH_SIZE);
		expect(reconcile).toHaveBeenCalledTimes(intermediateCount);

		batcher.finish();
		expect(reconcile).toHaveBeenCalledTimes(intermediateCount + 1);
		vi.runAllTimers();
		expect(reconcile).toHaveBeenCalledTimes(intermediateCount + 1);
	});

	it("flushes a partial batch after the time bound and cancels without a stale update", () => {
		vi.useFakeTimers();
		const reconcile = vi.fn();
		const batcher = new ProgressiveCatalogBatcher({
			maxBatchSize: SAVED_CATALOG_BATCH_SIZE,
			maxDelayMs: SAVED_CATALOG_BATCH_MAX_DELAY_MS,
			onFlush: reconcile,
		});
		batcher.add();
		vi.advanceTimersByTime(SAVED_CATALOG_BATCH_MAX_DELAY_MS - 1);
		expect(reconcile).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(reconcile).toHaveBeenCalledOnce();
		batcher.add();
		batcher.cancel();
		vi.runAllTimers();
		expect(reconcile).toHaveBeenCalledOnce();
	});

	it("preserves selection across progressive batches", () => {
		vi.useFakeTimers();
		const directory = createTemporaryDirectory();
		const target = savedSession(0, directory);
		const sessions = [target];
		let rows = buildAgentsViewRows(reconcileUnifiedSessions([], sessions));
		let selectedIndex = 0;
		const selectedIdentity = rows[0]?.identity;
		const selectedKey = getAgentsViewSelectionKey(rows[0]!.summary);
		const batcher = new ProgressiveCatalogBatcher({
			maxBatchSize: SAVED_CATALOG_BATCH_SIZE,
			maxDelayMs: SAVED_CATALOG_BATCH_MAX_DELAY_MS,
			onFlush: () => {
				rows = buildAgentsViewRows(reconcileUnifiedSessions([], sessions));
				selectedIndex = resolveAgentsViewSelectionState(rows, selectedIndex, selectedIdentity, selectedKey).index;
			},
		});

		for (let index = 1; index <= 100; index++) {
			sessions.push(savedSession(index, directory));
			batcher.add();
		}
		batcher.finish();

		expect(rows[selectedIndex]?.summary.sessionId).toBe(target.id);
	});

	it("preserves the selected row through mode-level catalog reconciliation", () => {
		const directory = createTemporaryDirectory();
		const target = savedSession(0, directory);
		const initialRows = buildAgentsViewRows(reconcileUnifiedSessions([], [target]));
		const persistentState: Record<string, unknown> = {};
		const self: Record<string, unknown> = {
			lastListedSummaries: [],
			savedSessions: [target],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			liveCatalogReady: true,
			savedCatalogReady: true,
			persistentState,
			scopeKey: undefined,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			selectedIndex: 0,
			selectedRowIdentity: initialRows[0]?.identity,
			selectedSessionKey: getAgentsViewSelectionKey(initialRows[0]!.summary),
			selectionAnchorPending: false,
			withPendingDeleteSession: (sessions: unknown[]) => sessions,
			getFilteredRecords: () => self.scopedRecords,
			applyPendingAncestorExpansion: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
		};
		self.restoreSelection = () => invokeAgentsView("restoreSelection", self);
		self.syncSelectedRowState = () => invokeAgentsView("syncSelectedRowState", self);

		self.savedSessions = [target, ...Array.from({ length: 100 }, (_, index) => savedSession(index + 1, directory))];
		invokeAgentsView("reconcileCatalogs", self);

		const rows = self.rows as Array<{ summary: { sessionId: string } }>;
		expect(rows[self.selectedIndex as number]?.summary.sessionId).toBe(target.id);
	});
});
