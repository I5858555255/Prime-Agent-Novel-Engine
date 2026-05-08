/**
 * Persistent IPython kernel driven via Jupyter's ZMQ messaging protocol.
 * Variables, imports, and loaded data persist across `execute()` calls.
 *
 * TODO: reconsider persistent-kernel vs stateless `python -c` once RLM-1
 * weights are available. If RLM-1's training tasks didn't materially
 * exploit state across turns, a ~30-line stateless implementation could
 * replace this whole file. M4 recursion needs the kernel namespace for
 * `await rlm('...')`, so this decision becomes load-bearing then.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { v4 as uuid } from "uuid";
import { Dealer, Subscriber } from "zeromq";

const DELIM = Buffer.from("<IDS|MSG>");
const PROTOCOL_VERSION = "5.3";
const STARTUP_DELAY_MS = 500;

export interface KernelManagerOptions {
	/** Python interpreter that has `ipykernel` available. */
	python: string;
	cwd?: string;
	/** Default: "prime-agent". */
	username?: string;
}

export interface ExecuteOptions {
	/** Aborting interrupts the kernel via the control channel. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Last `execute_result` payload (text/plain), if the cell produced one. */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

interface ConnectionInfo {
	ip: string;
	transport: "tcp";
	shell_port: number;
	iopub_port: number;
	stdin_port: number;
	control_port: number;
	hb_port: number;
	signature_scheme: "hmac-sha256";
	key: string;
	kernel_name: "python3";
}

interface JupyterMessage {
	header: {
		msg_id: string;
		session: string;
		username: string;
		date: string;
		msg_type: string;
		version: string;
	};
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

// ---- wire format ---------------------------------------------------------

function buildMessage(
	msgType: string,
	content: Record<string, unknown>,
	session: string,
	username: string,
): JupyterMessage {
	return {
		header: {
			msg_id: uuid(),
			session,
			username,
			date: new Date().toISOString(),
			msg_type: msgType,
			version: PROTOCOL_VERSION,
		},
		parent_header: {},
		metadata: {},
		content,
	};
}

function sign(parts: Buffer[], key: string): Buffer {
	const hmac = createHmac("sha256", key);
	for (const p of parts) hmac.update(p);
	return Buffer.from(hmac.digest("hex"));
}

function encode(msg: JupyterMessage, key: string): Buffer[] {
	const parts = [
		Buffer.from(JSON.stringify(msg.header)),
		Buffer.from(JSON.stringify(msg.parent_header)),
		Buffer.from(JSON.stringify(msg.metadata)),
		Buffer.from(JSON.stringify(msg.content)),
	];
	return [DELIM, sign(parts, key), ...parts];
}

function decode(frames: Buffer[]): JupyterMessage | null {
	let i = 0;
	while (i < frames.length && !frames[i].equals(DELIM)) i++;
	if (i + 5 >= frames.length) return null;
	try {
		return {
			header: JSON.parse(frames[i + 2].toString()),
			parent_header: JSON.parse(frames[i + 3].toString()),
			metadata: JSON.parse(frames[i + 4].toString()),
			content: JSON.parse(frames[i + 5].toString()),
		};
	} catch {
		return null;
	}
}

// ---- connection setup ----------------------------------------------------

function pickPorts(n: number): number[] {
	// Bind-to-0 + zeromq across all five sockets is fiddly. Random high
	// ports are sufficient given kernel sessions are local and short-lived.
	// Collisions surface on socket connect.
	const start = 50000 + Math.floor(Math.random() * 5000);
	return Array.from({ length: n }, (_, i) => start + i);
}

function makeConnection(): { info: ConnectionInfo; path: string; tempDir: string } {
	const [shell_port, iopub_port, stdin_port, control_port, hb_port] = pickPorts(5);
	const info: ConnectionInfo = {
		ip: "127.0.0.1",
		transport: "tcp",
		shell_port,
		iopub_port,
		stdin_port,
		control_port,
		hb_port,
		signature_scheme: "hmac-sha256",
		key: randomBytes(16).toString("hex"),
		kernel_name: "python3",
	};
	const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-"));
	const path = join(tempDir, "connection.json");
	writeFileSync(path, JSON.stringify(info, null, 2));
	return { info, path, tempDir };
}

// ---- kernel manager ------------------------------------------------------

export class KernelManager {
	private readonly options: Required<Omit<KernelManagerOptions, "cwd">> & { cwd?: string };
	private readonly session = uuid();
	private kernel?: ChildProcess;
	private shell?: Dealer;
	private iopub?: Subscriber;
	private control?: Dealer;
	private connection?: ConnectionInfo;
	private tempDir?: string;
	/** Serializes execute() calls — Jupyter shell channel is request/reply. */
	private executionQueue: Promise<unknown> = Promise.resolve();
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";

	constructor(options: KernelManagerOptions) {
		if (!existsSync(options.python)) {
			throw new Error(`Python interpreter not found: ${options.python}`);
		}
		this.options = {
			python: options.python,
			cwd: options.cwd,
			username: options.username ?? "prime-agent",
		};
	}

	async start(): Promise<void> {
		if (this.state !== "idle") return;
		this.state = "starting";

		const { info, path: connectionPath, tempDir } = makeConnection();
		this.connection = info;
		this.tempDir = tempDir;

		this.kernel = spawn(this.options.python, ["-m", "ipykernel_launcher", "-f", connectionPath], {
			cwd: this.options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		this.kernel.stderr?.on("data", (buf: Buffer) => {
			process.stderr.write(`[kernel] ${buf.toString()}`);
		});

		this.kernel.on("exit", (code, signal) => {
			if (this.state !== "shutdown") {
				console.error(`[kernel] unexpected exit code=${code} signal=${signal}`);
			}
			this.state = "shutdown";
		});

		this.shell = new Dealer();
		this.iopub = new Subscriber();
		this.control = new Dealer();
		this.shell.connect(`${info.transport}://${info.ip}:${info.shell_port}`);
		this.iopub.connect(`${info.transport}://${info.ip}:${info.iopub_port}`);
		this.control.connect(`${info.transport}://${info.ip}:${info.control_port}`);
		this.iopub.subscribe("");

		// ZMQ slow-joiner: give the kernel time to bind ports before publishing.
		await sleep(STARTUP_DELAY_MS);
		this.state = "running";
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		if (this.state === "idle") await this.start();
		if (this.state === "shutdown") {
			throw new Error("Kernel has been shut down");
		}

		const prev = this.executionQueue;
		let resolveNext: () => void = () => {};
		this.executionQueue = new Promise<void>((r) => {
			resolveNext = r;
		});
		await prev;

		const started = Date.now();
		try {
			return await this.executeInner(code, opts, started);
		} finally {
			resolveNext();
		}
	}

	private async executeInner(code: string, opts: ExecuteOptions, started: number): Promise<ExecuteResult> {
		const conn = this.connection!;
		const shell = this.shell!;
		const iopub = this.iopub!;

		const msg = buildMessage(
			"execute_request",
			{
				code,
				silent: false,
				store_history: true,
				user_expressions: {},
				allow_stdin: false,
				stop_on_error: true,
			},
			this.session,
			this.options.username,
		);
		const requestMsgId = msg.header.msg_id;
		await shell.send(encode(msg, conn.key));

		let stdout = "";
		let stderr = "";
		let result: string | undefined;
		let error: ExecuteResult["error"];
		let status: ExecuteResult["status"] = "ok";

		const onAbort = () => {
			this.interrupt().catch(() => {});
		};
		opts.signal?.addEventListener("abort", onAbort);

		try {
			for await (const frames of iopub) {
				const incoming = decode(frames);
				if (!incoming) continue;
				if ((incoming.parent_header as { msg_id?: string }).msg_id !== requestMsgId) continue;

				const t = incoming.header.msg_type;
				if (t === "stream") {
					const c = incoming.content as { name: "stdout" | "stderr"; text: string };
					if (c.name === "stdout") stdout += c.text;
					else stderr += c.text;
					opts.onStream?.(c.text, c.name);
				} else if (t === "execute_result") {
					const c = incoming.content as { data: Record<string, string> };
					if (c.data["text/plain"]) result = c.data["text/plain"];
				} else if (t === "error") {
					const c = incoming.content as { ename: string; evalue: string; traceback: string[] };
					error = c;
					status = "error";
				} else if (t === "status") {
					const c = incoming.content as { execution_state: string };
					if (c.execution_state === "idle") break;
				}
			}
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
		}

		if (opts.signal?.aborted) status = "aborted";

		return { stdout, stderr, result, error, status, durationMs: Date.now() - started };
	}

	private async interrupt(): Promise<void> {
		if (!this.control || !this.connection) return;
		const msg = buildMessage("interrupt_request", {}, this.session, this.options.username);
		await this.control.send(encode(msg, this.connection.key));
	}

	async shutdown(): Promise<void> {
		if (this.state === "shutdown") return;
		this.state = "shutdown";

		try {
			if (this.control && this.connection) {
				const msg = buildMessage("shutdown_request", { restart: false }, this.session, this.options.username);
				await this.control.send(encode(msg, this.connection.key));
				await sleep(200);
			}
		} catch {}

		this.shell?.close();
		this.iopub?.close();
		this.control?.close();
		try {
			this.kernel?.kill("SIGTERM");
		} catch {}
		if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
	}

	get isRunning(): boolean {
		return this.state === "running";
	}
}

// ---- Python interpreter resolution ---------------------------------------

/**
 * Resolve the Python interpreter to use for the kernel. Searched in order:
 *   1. PRIME_AGENT_KERNEL_PYTHON env var
 *   2. ~/.prime-agent/kernel-venv/bin/python (canonical user-install location)
 *   3. <repo>/.kernel-venv/bin/python (development; created by scripts/setup-kernel-venv.sh)
 */
export function resolveKernelPython(): string | null {
	const envOverride = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (envOverride && existsSync(envOverride)) return envOverride;

	const home = process.env.HOME;
	if (home) {
		const canonical = join(home, ".prime-agent", "kernel-venv", "bin", "python");
		if (existsSync(canonical)) return canonical;
	}

	for (let dir = process.cwd(); dir !== "/"; dir = join(dir, "..")) {
		const candidate = join(dir, ".kernel-venv", "bin", "python");
		if (existsSync(candidate)) return candidate;
	}

	return null;
}
