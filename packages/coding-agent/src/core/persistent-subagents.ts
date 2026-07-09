import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionContext,
	type SessionEntry,
	SessionManager,
} from "./session-manager.js";

/**
 * Persistent (reopenable) subagents.
 *
 * A normal RLM subagent is ephemeral: every `rlm.run(...)` mints a fresh
 * `sub-<uuid>` directory and session, so once the run finishes its conversation
 * can only be inspected, never continued. A persistent subagent is keyed by a
 * caller-chosen `persistent_id`: the first run creates a stable session under
 * `<root>/persistent-subagents/<slug>/`, and later runs with the same id reopen
 * that same session file, so history accumulates. The subagent's system prompt
 * (append) is stored alongside the session in a small JSON sidecar and re-applied
 * on every reopen, so a reopened subagent sees system prompt + saved history +
 * the new instruction for this run.
 *
 * History is stored with the existing append-only session JSONL format; only the
 * sidecar pointer (session file path + system prompt) is new.
 */

const PERSISTENT_SUBAGENTS_DIR_NAME = "persistent-subagents";
const SIDECAR_FILE_NAME = "subagent.json";
const SIDECAR_SCHEMA = 1;

export interface PersistentSubagentRecord {
	schema: number;
	/** Caller-chosen stable identity for this reopenable subagent. */
	id: string;
	/** Absolute path to the session JSONL file that holds this subagent's history. */
	sessionFile?: string;
	/** System prompt (append) stored with the subagent and re-applied on reopen. */
	systemPrompt?: string;
	createdAt: string;
	updatedAt: string;
	/** Number of times this subagent has been run (created + reopened). */
	runCount: number;
}

/**
 * Slug a persistent-subagent id into a filesystem-safe, collision-resistant
 * directory name. A readable, normalized prefix keeps directories browsable, and a
 * short hash of the exact id keeps distinct ids (differing only in case,
 * punctuation, spacing, or beyond the prefix length) from colliding into the same
 * directory and overwriting each other's history.
 */
export function slugifyPersistentSubagentId(id: string): string {
	const readable =
		id
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 60) || "subagent";
	const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
	return `${readable}-${hash}`;
}

/**
 * Deterministic node id for a persistent subagent, derived from its id. Stable
 * across reopens so the parent's child-run map and inspector reference one node.
 */
export function persistentSubagentNodeId(id: string): string {
	return `persist-${slugifyPersistentSubagentId(id)}`;
}

/** Directory that holds a persistent subagent's session file and sidecar. */
export function persistentSubagentDir(rootDir: string, id: string): string {
	return join(rootDir, PERSISTENT_SUBAGENTS_DIR_NAME, slugifyPersistentSubagentId(id));
}

function sidecarPath(dir: string): string {
	return join(dir, SIDECAR_FILE_NAME);
}

/** Load the sidecar record for a persistent subagent directory, if present and valid. */
export function loadPersistentSubagentRecord(dir: string): PersistentSubagentRecord | undefined {
	const path = sidecarPath(dir);
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return undefined;
		}
		const record = raw as Partial<PersistentSubagentRecord>;
		if (typeof record.id !== "string") {
			return undefined;
		}
		return {
			schema: typeof record.schema === "number" ? record.schema : SIDECAR_SCHEMA,
			id: record.id,
			sessionFile: typeof record.sessionFile === "string" ? record.sessionFile : undefined,
			systemPrompt: typeof record.systemPrompt === "string" ? record.systemPrompt : undefined,
			createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
			updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
			runCount: typeof record.runCount === "number" ? record.runCount : 0,
		};
	} catch {
		// A corrupt sidecar must not break the run: treat it as absent and let the
		// next save rewrite it cleanly.
		return undefined;
	}
}

/** Persist the sidecar record for a persistent subagent directory. */
export function savePersistentSubagentRecord(dir: string, record: PersistentSubagentRecord): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(sidecarPath(dir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * Resolve the existing session file for a persistent subagent. Considers the sidecar
 * pointer alongside every `.jsonl` in the directory and prefers the newest file that
 * actually has conversation history, so a stale sidecar pointer (e.g. to a
 * metadata-only file) can't permanently shadow a newer session with real history.
 * Falls back to the newest existing file when none has history yet (so a sidecar
 * written before its session materialized still resolves).
 */
export function findPersistentSubagentSessionFile(
	dir: string,
	record: PersistentSubagentRecord | undefined,
): string | undefined {
	const candidates = new Set<string>();
	if (record?.sessionFile && existsSync(record.sessionFile)) {
		candidates.add(resolve(record.sessionFile));
	}
	if (existsSync(dir)) {
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".jsonl")) {
				candidates.add(resolve(join(dir, name)));
			}
		}
	}
	if (candidates.size === 0) {
		return undefined;
	}
	// Newest by name: session ids are uuidv7 (time-ordered), so lexical max is newest.
	const sorted = [...candidates].sort();
	// Prefer the newest file that has real conversation history.
	for (let i = sorted.length - 1; i >= 0; i--) {
		if (persistentSubagentSessionHasHistory(sorted[i])) {
			return sorted[i];
		}
	}
	// None has history yet: fall back to the newest existing file.
	return sorted[sorted.length - 1];
}

/**
 * Read a session file's resolved context without ever mutating the file. Uses the
 * read-only `loadEntriesFromFile` + `buildSessionContext` path rather than
 * `SessionManager.open`, because opening a malformed/partially-unreadable session
 * truncates and rewrites it with a fresh empty header — a probe must never destroy
 * the history it inspects. Returns undefined when the file is missing/unreadable or
 * has no usable entries.
 */
export function readPersistentSubagentSessionContext(sessionFile: string): SessionContext | undefined {
	try {
		if (!existsSync(sessionFile)) {
			return undefined;
		}
		const entries = loadEntriesFromFile(sessionFile);
		if (entries.length === 0) {
			return undefined;
		}
		return buildSessionContext(entries as SessionEntry[]);
	} catch {
		return undefined;
	}
}

/**
 * Whether a session file holds actual conversation turns (not just metadata like
 * model/thinking-level entries). Used to decide whether reopening genuinely
 * continues history: a metadata-only or unreadable file is treated as no history,
 * so the run starts fresh instead of reporting a reopen that hydrates nothing.
 */
export function persistentSubagentSessionHasHistory(sessionFile: string): boolean {
	return (readPersistentSubagentSessionContext(sessionFile)?.messages.length ?? 0) > 0;
}

/**
 * Plan for one persistent-subagent run: where its session lives, whether this run
 * reopens prior history, and the system prompt to apply.
 */
export interface PersistentSubagentPlan {
	id: string;
	nodeId: string;
	dir: string;
	/** Existing session file to reopen, or undefined when creating a fresh session. */
	existingSessionFile?: string;
	reopened: boolean;
	systemPrompt?: string;
	record: PersistentSubagentRecord;
}

/**
 * Build the plan for a persistent-subagent run under `rootDir`. Reopens the prior
 * session when one exists, and resolves the effective system prompt (an explicit
 * `systemPrompt` overrides and updates the stored one; otherwise the stored one is
 * reused). Does not write anything to disk.
 */
export function planPersistentSubagentRun(options: {
	rootDir: string;
	id: string;
	systemPrompt?: string;
}): PersistentSubagentPlan {
	const dir = persistentSubagentDir(options.rootDir, options.id);
	const record = loadPersistentSubagentRecord(dir);
	const candidateSessionFile = findPersistentSubagentSessionFile(dir, record);
	// Only treat the run as a reopen when the prior session actually has conversation
	// turns; a leftover metadata-only JSONL would otherwise report reopened=true while
	// hydrating nothing (and re-appending model/thinking entries). Keeping the flag and
	// the hydration decision in one place keeps every transport consistent.
	const existingSessionFile =
		candidateSessionFile && persistentSubagentSessionHasHistory(candidateSessionFile)
			? candidateSessionFile
			: undefined;
	const systemPrompt = options.systemPrompt ?? record?.systemPrompt;
	const now = new Date().toISOString();
	const nextRecord: PersistentSubagentRecord = {
		schema: SIDECAR_SCHEMA,
		id: options.id,
		// When reopening, point at the reopened file. When starting fresh (no usable
		// history), drop any stale pointer so it can't shadow the new session that this run
		// creates; the run's success path rewrites it with the actual session file.
		sessionFile: existingSessionFile,
		systemPrompt,
		createdAt: record?.createdAt ?? now,
		updatedAt: now,
		runCount: (record?.runCount ?? 0) + 1,
	};
	return {
		id: options.id,
		nodeId: persistentSubagentNodeId(options.id),
		dir,
		existingSessionFile,
		reopened: existingSessionFile !== undefined,
		systemPrompt,
		record: nextRecord,
	};
}

/**
 * Create the SessionManager for a subagent runtime. Reopens `existingSessionFile`
 * (persistent subagent continuing prior history) when it exists; otherwise creates
 * a fresh session under `sessionDir`, linked to the parent session when known.
 *
 * Centralizes the create-vs-reopen decision shared by the inline, in-process, and
 * daemon subagent runtime creators so persistent reopen behaves identically across
 * transports.
 */
export function createSubagentSessionManager(options: {
	cwd: string;
	sessionDir: string;
	parentSessionFile?: string;
	existingSessionFile?: string;
}): SessionManager {
	if (options.existingSessionFile && existsSync(options.existingSessionFile)) {
		return SessionManager.open(options.existingSessionFile, options.sessionDir, options.cwd);
	}
	const manager = SessionManager.create(options.cwd, options.sessionDir);
	if (options.parentSessionFile) {
		manager.newSession({ parentSession: options.parentSessionFile });
	}
	return manager;
}
