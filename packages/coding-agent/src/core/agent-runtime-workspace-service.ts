import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	AgentRuntimeScheduler,
	type AgentRuntimeWorkspaceAuthority,
	type CreateAgentRuntimeSchedulerOptions,
} from "./agent-runtime-scheduler.js";

interface WorkspaceAuthorityRecord {
	version: 1;
	workspaceId: string;
	ownerId: string;
	epoch: number;
	pid: number;
	heartbeatAt: string;
	expiresAt: string;
	releasedAt?: string;
}

interface WorkspaceSchedulerPoolEntry {
	scheduler: AgentRuntimeScheduler;
	references: number;
}

export interface AcquireAgentRuntimeWorkspaceSchedulerOptions {
	workspacePath: string;
	agentDir: string;
	legacyStatePath?: string;
	integrationQualityGates?: CreateAgentRuntimeSchedulerOptions["integrationQualityGates"];
	resourceLeaseTtlMs?: number;
	workspaceAuthorityTtlMs?: number;
	conflictResolutionMaxAttempts?: number;
	conflictResolutionTimeoutMs?: number;
	now?: () => number;
}

export interface AgentRuntimeWorkspaceSchedulerHandle {
	scheduler: AgentRuntimeScheduler;
	workspaceRoot: string;
	statePath: string;
	release(): void;
}

const AUTHORITY_VERSION = 1;
const DEFAULT_AUTHORITY_TTL_MS = 30_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_ATTEMPTS = 100;
const LOCK_WAIT_MS = 10;
const schedulerPool = new Map<string, WorkspaceSchedulerPoolEntry>();
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function canonicalPath(path: string): string {
	const resolved = resolve(path);
	let canonical = resolved;
	try {
		canonical = realpathSync.native(resolved);
	} catch {
		canonical = resolved;
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function repositoryWorkspacePath(workspacePath: string): string {
	try {
		return canonicalPath(
			execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: workspacePath,
				encoding: "utf8",
				windowsHide: true,
			}).trim(),
		);
	} catch {
		return canonicalPath(workspacePath);
	}
}

function workspaceIdentity(workspacePath: string): { workspacePath: string; workspaceId: string } {
	const canonicalWorkspacePath = repositoryWorkspacePath(workspacePath);
	let identityPath = canonicalWorkspacePath;
	try {
		identityPath = canonicalPath(
			execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
				cwd: canonicalWorkspacePath,
				encoding: "utf8",
				windowsHide: true,
			}).trim(),
		);
	} catch {
		// Non-Git workspaces use their canonical cwd identity.
	}
	return {
		workspacePath: canonicalWorkspacePath,
		workspaceId: createHash("sha256").update(identityPath).digest("hex").slice(0, 24),
	};
}

function writeJsonAtomically(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporaryPath, path);
}

function parseAuthority(value: unknown): WorkspaceAuthorityRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== AUTHORITY_VERSION ||
		typeof record.workspaceId !== "string" ||
		typeof record.ownerId !== "string" ||
		typeof record.epoch !== "number" ||
		!Number.isInteger(record.epoch) ||
		typeof record.pid !== "number" ||
		!Number.isInteger(record.pid) ||
		typeof record.heartbeatAt !== "string" ||
		typeof record.expiresAt !== "string"
	) {
		return undefined;
	}
	return {
		version: AUTHORITY_VERSION,
		workspaceId: record.workspaceId,
		ownerId: record.ownerId,
		epoch: record.epoch,
		pid: record.pid,
		heartbeatAt: record.heartbeatAt,
		expiresAt: record.expiresAt,
		releasedAt: typeof record.releasedAt === "string" ? record.releasedAt : undefined,
	};
}

function readAuthority(path: string): WorkspaceAuthorityRecord | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseAuthority(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch {
		return undefined;
	}
}

function withWorkspaceLock<T>(lockPath: string, operation: () => T): T {
	for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt++) {
		try {
			mkdirSync(lockPath);
			try {
				return operation();
			} finally {
				rmSync(lockPath, { recursive: true, force: true });
			}
		} catch (error) {
			const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
			if (code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			Atomics.wait(lockWaitBuffer, 0, 0, LOCK_WAIT_MS);
		}
	}
	throw new Error(`Timed out acquiring Agent Runtime workspace lock: ${lockPath}`);
}

class FileWorkspaceAuthority implements AgentRuntimeWorkspaceAuthority {
	private readonly authorityPath: string;
	private readonly lockPath: string;
	private readonly workspaceId: string;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly ownerId = randomUUID();
	private epoch = 0;
	private writable = false;

	constructor(options: { workspaceRoot: string; workspaceId: string; ttlMs: number; now: () => number }) {
		this.authorityPath = join(options.workspaceRoot, "authority.json");
		this.lockPath = join(options.workspaceRoot, "authority.lock");
		this.workspaceId = options.workspaceId;
		this.ttlMs = options.ttlMs;
		this.now = options.now;
		this.tryAcquire();
	}

	isWritable(): boolean {
		if (!this.writable) return false;
		const record = readAuthority(this.authorityPath);
		const writable = Boolean(
			record &&
				record.workspaceId === this.workspaceId &&
				record.ownerId === this.ownerId &&
				record.epoch === this.epoch &&
				Date.parse(record.expiresAt) > this.now(),
		);
		if (!writable) this.writable = false;
		return writable;
	}

	assertWritable(): void {
		if (this.isWritable()) return;
		this.writable = false;
		const record = readAuthority(this.authorityPath);
		const owner = record ? `${record.ownerId} (pid ${record.pid}, epoch ${record.epoch})` : "unknown";
		throw new Error(`Agent Runtime workspace authority is owned by ${owner}; retry after its lease expires`);
	}

	renew(): boolean {
		if (!this.writable) return this.tryAcquire();
		return withWorkspaceLock(this.lockPath, () => {
			const current = readAuthority(this.authorityPath);
			if (!this.matches(current)) {
				this.writable = false;
				return false;
			}
			const heartbeatAt = new Date(this.now()).toISOString();
			writeJsonAtomically(this.authorityPath, {
				...current,
				heartbeatAt,
				expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
				releasedAt: undefined,
			} satisfies WorkspaceAuthorityRecord);
			return true;
		});
	}

	release(): void {
		if (!this.writable) return;
		withWorkspaceLock(this.lockPath, () => {
			const current = readAuthority(this.authorityPath);
			if (!this.matches(current)) return;
			const releasedAt = new Date(this.now()).toISOString();
			writeJsonAtomically(this.authorityPath, {
				...current,
				heartbeatAt: releasedAt,
				expiresAt: releasedAt,
				releasedAt,
			} satisfies WorkspaceAuthorityRecord);
		});
		this.writable = false;
	}

	describe(): { ownerId?: string; epoch?: number; expiresAt?: string; writable: boolean } {
		const current = readAuthority(this.authorityPath);
		return {
			ownerId: current?.ownerId,
			epoch: current?.epoch,
			expiresAt: current?.expiresAt,
			writable: this.isWritable(),
		};
	}

	private tryAcquire(): boolean {
		return withWorkspaceLock(this.lockPath, () => {
			const current = readAuthority(this.authorityPath);
			if (
				current &&
				current.workspaceId === this.workspaceId &&
				Date.parse(current.expiresAt) > this.now() &&
				!this.matches(current)
			) {
				this.writable = false;
				return false;
			}
			this.epoch = Math.max(0, current?.epoch ?? 0) + 1;
			const heartbeatAt = new Date(this.now()).toISOString();
			writeJsonAtomically(this.authorityPath, {
				version: AUTHORITY_VERSION,
				workspaceId: this.workspaceId,
				ownerId: this.ownerId,
				epoch: this.epoch,
				pid: process.pid,
				heartbeatAt,
				expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
			} satisfies WorkspaceAuthorityRecord);
			this.writable = true;
			return true;
		});
	}

	private matches(record: WorkspaceAuthorityRecord | undefined): record is WorkspaceAuthorityRecord {
		return Boolean(record && record.ownerId === this.ownerId && record.epoch === this.epoch);
	}
}

function persistedRunId(statePath: string, fallback: string): string {
	if (!existsSync(statePath)) return fallback;
	try {
		const value = JSON.parse(readFileSync(statePath, "utf8")) as { runId?: unknown };
		return typeof value.runId === "string" && value.runId ? value.runId : fallback;
	} catch {
		return fallback;
	}
}

export function acquireAgentRuntimeWorkspaceScheduler(
	options: AcquireAgentRuntimeWorkspaceSchedulerOptions,
): AgentRuntimeWorkspaceSchedulerHandle {
	const identity = workspaceIdentity(options.workspacePath);
	const workspaceRoot = join(resolve(options.agentDir), "agent-runtime-workspaces", identity.workspaceId);
	const statePath = join(workspaceRoot, "scheduler.json");
	mkdirSync(workspaceRoot, { recursive: true });
	if (!existsSync(statePath) && options.legacyStatePath && existsSync(options.legacyStatePath)) {
		copyFileSync(options.legacyStatePath, statePath);
	}
	const poolKey = canonicalPath(statePath);
	const existing = schedulerPool.get(poolKey);
	if (existing) {
		const configuredQualityGates = options.integrationQualityGates ?? [];
		if (
			configuredQualityGates.length > 0 &&
			JSON.stringify(configuredQualityGates) !== JSON.stringify(existing.scheduler.getIntegrationQualityGates())
		) {
			throw new Error("Agent Runtime integration quality gates do not match the active workspace policy");
		}
		existing.references++;
		let released = false;
		return {
			scheduler: existing.scheduler,
			workspaceRoot,
			statePath,
			release: () => {
				if (released) return;
				released = true;
				releasePoolEntry(poolKey, existing);
			},
		};
	}
	const now = options.now ?? Date.now;
	const workspaceAuthorityTtlMs = options.workspaceAuthorityTtlMs ?? DEFAULT_AUTHORITY_TTL_MS;
	if (!Number.isFinite(workspaceAuthorityTtlMs) || workspaceAuthorityTtlMs <= 0) {
		throw new Error("Agent Runtime workspaceAuthorityTtlMs must be a positive finite number");
	}
	const authority = new FileWorkspaceAuthority({
		workspaceRoot,
		workspaceId: identity.workspaceId,
		ttlMs: workspaceAuthorityTtlMs,
		now,
	});
	let scheduler: AgentRuntimeScheduler;
	try {
		scheduler = new AgentRuntimeScheduler({
			workspacePath: identity.workspacePath,
			runId: persistedRunId(statePath, `workspace-${identity.workspaceId}`),
			statePath,
			now,
			integrationQualityGates: options.integrationQualityGates,
			resourceLeaseTtlMs: options.resourceLeaseTtlMs,
			conflictResolutionMaxAttempts: options.conflictResolutionMaxAttempts,
			conflictResolutionTimeoutMs: options.conflictResolutionTimeoutMs,
			workspaceAuthority: authority,
		});
	} catch (error) {
		authority.release();
		throw error;
	}
	const entry: WorkspaceSchedulerPoolEntry = { scheduler, references: 1 };
	schedulerPool.set(poolKey, entry);
	let released = false;
	return {
		scheduler,
		workspaceRoot,
		statePath,
		release: () => {
			if (released) return;
			released = true;
			releasePoolEntry(poolKey, entry);
		},
	};
}

function releasePoolEntry(poolKey: string, entry: WorkspaceSchedulerPoolEntry): void {
	entry.references = Math.max(0, entry.references - 1);
	if (entry.references > 0 || schedulerPool.get(poolKey) !== entry) return;
	schedulerPool.delete(poolKey);
	entry.scheduler.releaseWorkspaceAuthority();
}
