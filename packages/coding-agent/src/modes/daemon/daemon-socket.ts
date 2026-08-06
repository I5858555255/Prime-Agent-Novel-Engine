import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

const DAEMON_SOCKET_MODE = 0o600;
const DAEMON_SOCKET_DIR_MODE = 0o700;
const DAEMON_SOCKET_RELEASE_GRACE_MS = 1000;
const DAEMON_SOCKET_RELEASE_POLL_MS = 25;
const DAEMON_SOCKET_LOCK_STALE_MS = 5000;
const DAEMON_SOCKET_LOCK_UPDATE_MS = 1000;

export class DaemonSocketPathLease {
	private released = false;

	constructor(
		readonly socketPath: string,
		private readonly releaseLock: () => Promise<void>,
	) {}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		await this.releaseLock();
	}
}

export interface DaemonSocketIdentity {
	dev: number;
	ino: number;
}

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		return "\\\\.\\pipe\\prime-agent-daemon";
	}
	return join(defaultDaemonSocketDir(), "daemon.sock");
}

export async function acquireDaemonSocketPathLease(socketPath: string): Promise<DaemonSocketPathLease | undefined> {
	ensureDefaultDaemonSocketDir(socketPath);
	if (process.platform === "win32") {
		return undefined;
	}
	const releaseLock = await lockfile.lock(socketPath, {
		realpath: false,
		stale: DAEMON_SOCKET_LOCK_STALE_MS,
		update: DAEMON_SOCKET_LOCK_UPDATE_MS,
		retries: {
			retries: 600,
			factor: 1,
			minTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
			maxTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
		},
	});
	return new DaemonSocketPathLease(socketPath, releaseLock);
}

export async function prepareDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): Promise<void> {
	ensureDefaultDaemonSocketDir(socketPath);

	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		await prepareUnixDaemonSocketPath(socketPath);
		return;
	}
	if (!existsSync(socketPath)) {
		return;
	}
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const ownedLease = await acquireDaemonSocketPathLease(socketPath);
	try {
		await prepareUnixDaemonSocketPath(socketPath);
	} finally {
		await ownedLease?.release();
	}
}

async function prepareUnixDaemonSocketPath(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (!stat.isSocket()) {
		throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
	}

	const staleIdentity: DaemonSocketIdentity = { dev: stat.dev, ino: stat.ino };
	if (await canConnectToUnixSocket(socketPath)) {
		throw new Error(`Daemon socket already in use: ${socketPath}`);
	}
	const deadline = Date.now() + DAEMON_SOCKET_RELEASE_GRACE_MS;
	while (Date.now() < deadline) {
		await delay(DAEMON_SOCKET_RELEASE_POLL_MS);
		if (!existsSync(socketPath)) {
			return;
		}
		let currentIdentity: DaemonSocketIdentity | undefined;
		try {
			currentIdentity = getDaemonSocketIdentity(socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		if (!currentIdentity || currentIdentity.dev !== staleIdentity.dev || currentIdentity.ino !== staleIdentity.ino) {
			throw new Error(`Daemon socket changed ownership while waiting for cleanup: ${socketPath}`);
		}
		if (await canConnectToUnixSocket(socketPath)) {
			throw new Error(`Daemon socket already in use: ${socketPath}`);
		}
	}

	unlinkSync(socketPath);
}

export function restrictDaemonSocketPath(socketPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	chmodSync(socketPath, DAEMON_SOCKET_MODE);
}

export function getDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	if (process.platform === "win32") {
		return undefined;
	}
	const stat = lstatSync(socketPath);
	return { dev: stat.dev, ino: stat.ino };
}

export function cleanupDaemonSocketPath(
	socketPath: string,
	expectedIdentity?: DaemonSocketIdentity,
	lease?: DaemonSocketPathLease,
): void {
	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		try {
			cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
		} catch {
			// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
		}
		return;
	}
	let releaseLock: (() => void) | undefined;
	try {
		releaseLock = lockfile.lockSync(socketPath, {
			realpath: false,
			stale: DAEMON_SOCKET_LOCK_STALE_MS,
			update: DAEMON_SOCKET_LOCK_UPDATE_MS,
			retries: 0,
		});
	} catch {
		return;
	}
	try {
		cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
	} catch {
		// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
	} finally {
		try {
			releaseLock();
		} catch {
			// Best effort cleanup; a failed release is recoverable as a stale lock.
		}
	}
}

function cleanupUnixDaemonSocketPath(socketPath: string, expectedIdentity?: DaemonSocketIdentity): void {
	if (!existsSync(socketPath)) {
		return;
	}
	if (expectedIdentity) {
		const currentIdentity = getDaemonSocketIdentity(socketPath);
		if (
			!currentIdentity ||
			currentIdentity.dev !== expectedIdentity.dev ||
			currentIdentity.ino !== expectedIdentity.ino
		) {
			return;
		}
	}
	unlinkSync(socketPath);
}

function assertSocketLease(socketPath: string, lease: DaemonSocketPathLease): void {
	if (lease.socketPath !== socketPath) {
		throw new Error(`Daemon socket lease does not match ${socketPath}`);
	}
}

/**
 * Longest path a unix domain socket can be bound to.
 *
 * The kernel copies the name into `sockaddr_un.sun_path`, a fixed 104-byte
 * field on macOS and the BSDs and 108 on Linux, including the terminator.
 * Overrunning it does not report itself as "name too long": the name is
 * truncated, so the server binds one path while clients dial another and the
 * failure surfaces later as ENOTSOCK or ECONNREFUSED.
 */
const UNIX_SOCKET_PATH_MAX = process.platform === "linux" ? 108 : 104;

/** `worker-<12 hex>-<12 hex>.sock`, the longest name placed in the socket dir. */
const LONGEST_DAEMON_SOCKET_NAME = "worker-000000000000-000000000000.sock";

function fitsUnixSocketPath(socketPath: string): boolean {
	return Buffer.byteLength(socketPath) < UNIX_SOCKET_PATH_MAX;
}

/**
 * Per-user directory holding this user's daemon and worker sockets.
 *
 * The preferred location is under the temporary directory, but macOS spends 49
 * bytes of the 104-byte budget on `$TMPDIR` alone, leaving a stock machine two
 * bytes of headroom — a five-digit uid, or a `TMPDIR` a test or sandbox
 * redirects somewhere deeper, overruns it. When the longest socket name would
 * not fit, fall back to a short directory whose name is derived from the
 * preferred one, so every process computing this agrees on the result and
 * separate `TMPDIR`s stay separate. Paths that already fit are untouched.
 */
export function defaultDaemonSocketDir(): string {
	const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	const preferred = join(tmpdir(), `prime-agent-${suffix}`);
	if (process.platform === "win32" || fitsUnixSocketPath(join(preferred, LONGEST_DAEMON_SOCKET_NAME))) {
		return preferred;
	}
	const key = createHash("sha256").update(preferred).digest("hex").slice(0, 8);
	return join("/tmp", `prime-agent-${suffix}-${key}`);
}

function ensureDefaultDaemonSocketDir(socketPath: string): void {
	if (process.platform === "win32" || dirname(socketPath) !== defaultDaemonSocketDir()) {
		return;
	}

	if (!existsSync(defaultDaemonSocketDir())) {
		mkdirSync(defaultDaemonSocketDir(), { recursive: true, mode: DAEMON_SOCKET_DIR_MODE });
	}

	const stat = lstatSync(defaultDaemonSocketDir());
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory exists and is not a directory: ${defaultDaemonSocketDir()}`);
	}

	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Daemon socket directory is not owned by the current user: ${defaultDaemonSocketDir()}`);
	}

	chmodSync(defaultDaemonSocketDir(), DAEMON_SOCKET_DIR_MODE);
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (canConnect: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};

		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
