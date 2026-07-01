// Node-side client for the Python kernel forkserver (see fork-server-script.ts).
// One forkserver process per (python, cwd, env) profile, spawned lazily and kept
// alive for the agent process. Each KernelManager asks it to fork a kernel onto a
// connection file instead of paying a full `python -m ipykernel_launcher` cold boot.
//
// Everything degrades to direct spawn: if the forkserver is disabled, unavailable,
// or a spawn request fails/times out, callers catch ForkServerUnavailable and fall
// back to the existing path, so correctness never depends on fork.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { FORK_SERVER_SCRIPT } from "./fork-server-script.js";

const READY_TIMEOUT_MS = 30_000;
const SPAWN_TIMEOUT_MS = 10_000;
const STDERR_TAIL_MAX = 4096;

export class ForkServerUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForkServerUnavailable";
	}
}

/** Fork is a Linux-only, in-process fan-out optimization. */
export function isForkServerEnabled(): boolean {
	return process.platform === "linux" && process.env.PRIME_AGENT_KERNEL_FORKSERVER === "1";
}

interface ForkServerParams {
	python: string;
	cwd?: string;
	env?: Record<string, string>;
}

type PendingSpawn = {
	resolve: (pid: number) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

class ForkServer {
	private readonly params: ForkServerParams;
	private proc?: ChildProcess;
	private server?: Server;
	private conn?: Socket;
	private socketDir?: string;
	private readyPromise?: Promise<void>;
	private failReady?: (err: Error) => void;
	private buffer = "";
	// Rolling tail of forkserver stderr. Forked children inherit this fd, so a
	// child's import/startup traceback lands here; surfaced in error messages.
	private stderrTail = "";
	private nextId = 1;
	private readonly pending = new Map<number, PendingSpawn>();
	private dead = false;

	constructor(params: ForkServerParams) {
		this.params = params;
	}

	get isDead(): boolean {
		return this.dead;
	}

	private async ensureReady(): Promise<void> {
		if (this.dead) throw new ForkServerUnavailable("forkserver is dead");
		if (!this.readyPromise) {
			this.readyPromise = this.start().catch((err) => {
				this.markDead();
				throw err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err));
			});
		}
		return this.readyPromise;
	}

	private start(): Promise<void> {
		this.socketDir = mkdtempSync(join(tmpdir(), "prime-agent-forkserver-"));
		const socketPath = join(this.socketDir, "control.sock");

		return new Promise<void>((resolve, reject) => {
			const server = createServer();
			this.server = server;

			let settled = false;
			const readyTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ForkServerUnavailable(`forkserver did not become ready within ${READY_TIMEOUT_MS}ms`));
			}, READY_TIMEOUT_MS);

			// Lets markDead() fail a still-pending start (interpreter crashed / socket
			// closed before "ready") instead of waiting out the full ready timeout.
			this.failReady = (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				reject(err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err)));
			};

			server.on("connection", (socket) => {
				this.conn = socket;
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("close", () => this.markDead());
				socket.on("error", () => this.markDead());
			});

			server.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				reject(new ForkServerUnavailable(`forkserver control socket failed: ${err.message}`));
			});

			// Buffered until the "ready" line; flip the promise from there.
			this.onReady = () => {
				if (settled) return;
				settled = true;
				clearTimeout(readyTimer);
				resolve();
			};

			server.listen(socketPath, () => {
				const proc = spawn(this.params.python, ["-c", FORK_SERVER_SCRIPT, socketPath], {
					cwd: this.params.cwd,
					env: this.params.env ? { ...process.env, ...this.params.env } : process.env,
					stdio: ["ignore", "ignore", "pipe"],
				});
				this.proc = proc;
				proc.stderr?.on("data", (buf: Buffer) => {
					this.stderrTail = `${this.stderrTail}${buf.toString()}`.slice(-STDERR_TAIL_MAX);
				});
				proc.on("error", () => this.markDead());
				proc.on("exit", () => this.markDead());
			});
		});
	}

	private onReady: () => void = () => {};

	private onData(chunk: string): void {
		this.buffer += chunk;
		for (let idx = this.buffer.indexOf("\n"); idx !== -1; idx = this.buffer.indexOf("\n")) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg: { type?: string; id?: number; pid?: number; error?: string };
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.type === "ready") {
				this.onReady();
				continue;
			}
			if (typeof msg.id !== "number") continue;
			const p = this.pending.get(msg.id);
			if (!p) continue;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (typeof msg.pid === "number") {
				p.resolve(msg.pid);
			} else {
				p.reject(new ForkServerUnavailable(this.withStderr(msg.error ?? "forkserver fork failed")));
			}
		}
	}

	async spawnKernel(connectionPath: string): Promise<number> {
		await this.ensureReady();
		if (this.dead || !this.conn) throw new ForkServerUnavailable("forkserver connection unavailable");
		const id = this.nextId++;
		return new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new ForkServerUnavailable(`forkserver spawn timed out after ${SPAWN_TIMEOUT_MS}ms`));
			}, SPAWN_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			this.conn?.write(`${JSON.stringify({ id, connectionPath })}\n`);
		});
	}

	private withStderr(message: string): string {
		const tail = this.stderrTail.trim();
		return tail ? `${message}\nforkserver stderr:\n${tail}` : message;
	}

	private markDead(): void {
		if (this.dead) return;
		this.dead = true;
		this.failReady?.(new ForkServerUnavailable(this.withStderr("forkserver died before ready")));
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new ForkServerUnavailable(this.withStderr("forkserver died")));
		}
		this.pending.clear();
		this.dispose();
	}

	dispose(): void {
		// Reject in-flight callers before flipping `dead`, so the close/exit events
		// this triggers still reach markDead() instead of being short-circuited and
		// leaving callers to wait out their full timeouts.
		if (!this.dead) {
			this.failReady?.(new ForkServerUnavailable("forkserver disposed"));
			for (const p of this.pending.values()) {
				clearTimeout(p.timer);
				p.reject(new ForkServerUnavailable("forkserver disposed"));
			}
			this.pending.clear();
		}
		this.dead = true;
		try {
			this.conn?.destroy();
		} catch {}
		try {
			this.server?.close();
		} catch {}
		try {
			this.proc?.kill("SIGTERM");
		} catch {}
		if (this.socketDir) {
			try {
				rmSync(this.socketDir, { recursive: true, force: true });
			} catch {}
			this.socketDir = undefined;
		}
	}
}

// Keyed so kernels with different interpreters/cwd/env each get their own template.
const servers = new Map<string, ForkServer>();
let cleanupRegistered = false;

function keyFor(params: ForkServerParams): string {
	return JSON.stringify([params.python, params.cwd ?? "", params.env ?? null]);
}

/**
 * Fork a kernel onto `connectionPath` from the shared template for this profile.
 * Throws ForkServerUnavailable if forking is disabled or fails — callers fall back
 * to direct spawn. Returns the forked child's pid (owned/killed by the caller).
 */
export async function forkKernel(params: ForkServerParams, connectionPath: string): Promise<number> {
	if (!isForkServerEnabled()) throw new ForkServerUnavailable("forkserver disabled");
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		// A forkserver is process-lived and shared across sessions, so only tear it
		// down on full process shutdown (no sessionId). Per-session cleanup must not
		// yank the warm template out from under other live sessions.
		registerSessionResourceCleanup((sessionId) => {
			if (!sessionId) disposeAllForkServers();
		});
	}
	const key = keyFor(params);
	let server = servers.get(key);
	if (!server || server.isDead) {
		server = new ForkServer(params);
		servers.set(key, server);
	}
	try {
		return await server.spawnKernel(connectionPath);
	} catch (err) {
		if (server.isDead) servers.delete(key);
		throw err instanceof ForkServerUnavailable ? err : new ForkServerUnavailable(String(err));
	}
}

export function disposeAllForkServers(): void {
	for (const server of servers.values()) server.dispose();
	servers.clear();
}
