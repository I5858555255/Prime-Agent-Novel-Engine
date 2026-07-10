import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SESSION_LEASES_ENABLED_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASES";
export const SESSION_LEASE_OWNER_ID_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID";

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
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
			const owner = readLeaseOwner(this.directory);
			if (owner?.token === this.token) {
				rmSync(this.directory, { recursive: true, force: true });
			}
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

function readLeaseOwner(directory: string): SessionLeaseOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			return undefined;
		}
		return parsed as SessionLeaseOwner;
	} catch {
		return undefined;
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
	const canonicalPath = resolve(sessionPath);
	const root = join(agentDir, "session-leases");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = leaseDirectory(agentDir, canonicalPath);

	for (let attempt = 0; attempt < 3; attempt++) {
		const token = randomUUID();
		const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
		const owner: SessionLeaseOwner = {
			version: 1,
			token,
			pid: process.pid,
			activeSessionId: environment[SESSION_LEASE_OWNER_ID_ENV],
			sessionPath: canonicalPath,
			createdAt: new Date().toISOString(),
		};
		mkdirSync(candidateDirectory, { mode: 0o700 });
		writeFileSync(join(candidateDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
		try {
			renameSync(candidateDirectory, directory);
			return new SessionLease(canonicalPath, directory, token);
		} catch (error) {
			rmSync(candidateDirectory, { recursive: true, force: true });
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") {
				throw error;
			}
			const owner = readLeaseOwner(directory);
			if (owner && isProcessAlive(owner.pid)) {
				throw new SessionAlreadyActiveError(canonicalPath, owner.activeSessionId);
			}
			if (!reclaimStaleLease(directory)) {
			}
		}
	}

	const owner = existsSync(directory) ? readLeaseOwner(directory) : undefined;
	throw new SessionAlreadyActiveError(canonicalPath, owner?.activeSessionId);
}
