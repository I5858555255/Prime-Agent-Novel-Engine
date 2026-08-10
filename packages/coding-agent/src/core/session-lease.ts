import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";

export const SESSION_LEASES_ENABLED_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASES";
export const SESSION_LEASE_OWNER_ID_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID";

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	processStartId?: string;
	activeSessionId?: string;
	sessionPath: string;
	createdAt: string;
}

export class SessionAlreadyActiveError extends Error {
	readonly code = "session_already_active" as const;

	constructor(
		readonly sessionPath: string,
		readonly activeSessionId?: string,
	) {
		super(
			activeSessionId
				? `Session is already active in ${activeSessionId}: ${sessionPath}`
				: `Session is already active in another process: ${sessionPath}`,
		);
		this.name = "SessionAlreadyActiveError";
	}
}

export class SessionLease {
	private released = false;

	constructor(
		readonly sessionPath: string,
		private readonly directory: string,
		private readonly token: string,
	) {}

	release(): void {
		if (this.released) {
			return;
		}
		this.released = true;
		try {
			withLeaseGuard(this.directory, () => {
				const read = readLeaseOwner(this.directory);
				if (read.status === "owner" && read.owner.token === this.token) {
					rmSync(this.directory, { recursive: true, force: true });
				}
			});
		} catch {
			// Lease cleanup is best-effort. A stale owner is reclaimed by the next process.
		}
	}
}

function leasesEnabled(environment: NodeJS.ProcessEnv): boolean {
	const value = environment[SESSION_LEASES_ENABLED_ENV]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function leaseDirectory(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return join(agentDir, "session-leases", `${key}.lock`);
}

export function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	try {
		return realpathSync(resolvedPath);
	} catch {
		try {
			return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

type LeaseOwnerRead = { status: "owner"; owner: SessionLeaseOwner } | { status: "absent" } | { status: "unreadable" };

function readLeaseOwner(directory: string): LeaseOwnerRead {
	let raw: string;
	try {
		raw = readFileSync(join(directory, "owner.json"), "utf8");
	} catch (error) {
		// A missing file means there is genuinely no owner. Any other read error (a briefly
		// held handle from antivirus or the search indexer on Windows, EBUSY/EPERM/EACCES)
		// means we cannot prove the lease is stale, so treat it as a live owner rather than
		// reclaiming a possibly-active session. Mirrors isProcessAlive's EPERM handling.
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "unreadable" };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			return { status: "absent" };
		}
		return { status: "owner", owner: parsed as SessionLeaseOwner };
	} catch {
		return { status: "absent" };
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

type ProcessQuery = (command: string, args: string[]) => string;

function runProcessQuery(command: string, args: string[]): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		const startTicks = query("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		]).trim();
		return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

export function getProcessStartId(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (process.platform === "win32") {
		return getWindowsProcessStartId(pid);
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields = stat.slice(commandEnd + 2).split(" ");
		const startTime = fields[19];
		if (startTime) {
			return `proc:${startTime}`;
		}
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const startTime = runProcessQuery("ps", ["-p", String(pid), "-o", "lstart="]).trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

let currentProcessStartId: string | undefined;
let currentProcessStartIdRead = false;

function getCurrentProcessStartId(): string | undefined {
	if (!currentProcessStartIdRead) {
		currentProcessStartId = getProcessStartId(process.pid);
		currentProcessStartIdRead = true;
	}
	return currentProcessStartId;
}

function isLeaseOwnerAlive(owner: SessionLeaseOwner): boolean {
	if (!isProcessAlive(owner.pid)) {
		return false;
	}
	if (!owner.processStartId) {
		return true;
	}
	const currentStartId = getProcessStartId(owner.pid);
	return currentStartId === undefined || currentStartId === owner.processStartId;
}

function withLeaseGuard<T>(directory: string, action: () => T): T {
	let release: (() => void) | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(directory, {
				realpath: false,
				lockfilePath: `${directory}.guard`,
				stale: 5000,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
				throw error;
			}
			if (attempt === 99) {
				throw new Error(`Could not coordinate session lease: ${directory}`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!release) {
		throw new Error(`Could not coordinate session lease: ${directory}`);
	}
	try {
		return action();
	} finally {
		release();
	}
}

export function isRenameTargetExistsError(
	code: string | undefined,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (code === "EEXIST" || code === "ENOTEMPTY") {
		return true;
	}
	// Windows rejects a renameSync onto an existing non-empty directory with
	// EPERM or EACCES instead of the POSIX EEXIST/ENOTEMPTY, so a stale lease
	// would otherwise rethrow here and permanently block session recovery.
	return platform === "win32" && (code === "EPERM" || code === "EACCES");
}

function reclaimStaleLease(directory: string): boolean {
	const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
	try {
		renameSync(directory, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return true;
		}
		return false;
	}
	rmSync(stalePath, { recursive: true, force: true });
	return true;
}

export function acquireSessionLease(
	sessionPath: string | undefined,
	agentDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): SessionLease | undefined {
	if (!sessionPath || !leasesEnabled(environment)) {
		return undefined;
	}
	const canonicalPath = canonicalSessionPath(sessionPath);
	const root = join(agentDir, "session-leases");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = leaseDirectory(agentDir, canonicalPath);

	return withLeaseGuard(directory, () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const token = randomUUID();
			const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
			const owner: SessionLeaseOwner = {
				version: 1,
				token,
				pid: process.pid,
				processStartId: getCurrentProcessStartId(),
				activeSessionId: environment[SESSION_LEASE_OWNER_ID_ENV],
				sessionPath: canonicalPath,
				createdAt: new Date().toISOString(),
			};
			mkdirSync(candidateDirectory, { mode: 0o700 });
			writeFileSync(join(candidateDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
				mode: 0o600,
			});
			try {
				renameSync(candidateDirectory, directory);
				return new SessionLease(canonicalPath, directory, token);
			} catch (error) {
				rmSync(candidateDirectory, { recursive: true, force: true });
				const code = (error as NodeJS.ErrnoException).code;
				if (!isRenameTargetExistsError(code)) {
					throw error;
				}
				const existing = readLeaseOwner(directory);
				if (existing.status === "unreadable") {
					// Cannot prove the lease is stale (owner.json is present but unreadable),
					// so assume a live owner instead of reclaiming a possibly-active session.
					throw new SessionAlreadyActiveError(canonicalPath);
				}
				if (existing.status === "owner" && isLeaseOwnerAlive(existing.owner)) {
					throw new SessionAlreadyActiveError(canonicalPath, existing.owner.activeSessionId);
				}
				reclaimStaleLease(directory);
			}
		}

		if (existsSync(directory)) {
			const read = readLeaseOwner(directory);
			if (read.status === "unreadable") {
				throw new SessionAlreadyActiveError(canonicalPath);
			}
			if (read.status === "owner" && isLeaseOwnerAlive(read.owner)) {
				throw new SessionAlreadyActiveError(canonicalPath, read.owner.activeSessionId);
			}
		}
		throw new Error(`Could not acquire session lease: ${canonicalPath}`);
	});
}
