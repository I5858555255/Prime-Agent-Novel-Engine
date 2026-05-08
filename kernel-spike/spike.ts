/**
 * Kernel boundary spike.
 *
 * What this validates: TS can drive a Python IPython kernel via Jupyter's ZMQ
 * messaging protocol, with state persisting across requests.
 *
 * Flow:
 *   1. Generate a Jupyter connection file (random ports, HMAC key).
 *   2. Spawn the kernel: `python -m ipykernel_launcher -f connection.json`.
 *   3. Connect DEALER socket to shell port and SUB socket to iopub port.
 *   4. Send execute_request #1: `print("hello"); x = 42`.
 *   5. Read iopub stream messages until we observe status: idle.
 *   6. Send execute_request #2: `print(x * 2)` — verifies state persistence.
 *   7. Read iopub messages, expect "84".
 *   8. SIGTERM the kernel and clean up.
 *
 * Pass criteria: both prints observed, the second one reads `x` set by the first.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Dealer, Subscriber } from "zeromq";
import { v4 as uuid } from "uuid";

// ---- types ---------------------------------------------------------------

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

// ---- constants -----------------------------------------------------------

const DELIM = Buffer.from("<IDS|MSG>");
const PROTOCOL_VERSION = "5.3";
const SESSION = uuid();
const USERNAME = "kernel-spike";
const VENV_PYTHON = join(import.meta.dirname, ".venv", "bin", "python");

// ---- connection setup ----------------------------------------------------

function pickPorts(n: number): number[] {
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
	const tempDir = mkdtempSync(join(tmpdir(), "kernel-spike-"));
	const path = join(tempDir, "connection.json");
	writeFileSync(path, JSON.stringify(info, null, 2));
	return { info, path, tempDir };
}

// ---- wire format ---------------------------------------------------------

function buildMessage(msgType: string, content: Record<string, unknown>): JupyterMessage {
	return {
		header: {
			msg_id: uuid(),
			session: SESSION,
			username: USERNAME,
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
	// Need: DELIM, sig, header, parent_header, metadata, content (6 frames including DELIM).
	if (i + 5 >= frames.length) return null;
	return {
		header: JSON.parse(frames[i + 2].toString()),
		parent_header: JSON.parse(frames[i + 3].toString()),
		metadata: JSON.parse(frames[i + 4].toString()),
		content: JSON.parse(frames[i + 5].toString()),
	};
}

// ---- main ----------------------------------------------------------------

async function main(): Promise<void> {
	const { info, path: connectionPath, tempDir } = makeConnection();
	console.log(`connection file: ${connectionPath}`);

	// Spawn the kernel
	const kernel: ChildProcess = spawn(
		VENV_PYTHON,
		["-m", "ipykernel_launcher", "-f", connectionPath],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
	console.log(`spawned kernel pid=${kernel.pid}`);

	const cleanup = () => {
		try {
			kernel.kill("SIGTERM");
		} catch {}
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});

	// Connect sockets BEFORE the kernel might publish — ZMQ slow-joiner mitigation.
	const shell = new Dealer();
	const iopub = new Subscriber();
	shell.connect(`${info.transport}://${info.ip}:${info.shell_port}`);
	iopub.connect(`${info.transport}://${info.ip}:${info.iopub_port}`);
	iopub.subscribe(""); // all topics

	// Give the kernel a moment to come up and bind its ports.
	await sleep(500);

	// Helper: send execute_request, collect iopub stream output until status: idle.
	async function execute(code: string): Promise<{ stdout: string[]; status: string }> {
		const msg = buildMessage("execute_request", {
			code,
			silent: false,
			store_history: true,
			user_expressions: {},
			allow_stdin: false,
			stop_on_error: true,
		});
		const requestMsgId = msg.header.msg_id;
		await shell.send(encode(msg, info.key));

		const stdout: string[] = [];
		let status = "unknown";
		// Read iopub until we see this request's status: idle.
		for await (const frames of iopub) {
			const incoming = decode(frames);
			if (!incoming) continue;
			// Filter to messages parented by our request.
			if ((incoming.parent_header as { msg_id?: string }).msg_id !== requestMsgId) continue;

			const t = incoming.header.msg_type;
			if (t === "stream") {
				const c = incoming.content as { name: string; text: string };
				stdout.push(c.text);
			} else if (t === "status") {
				const c = incoming.content as { execution_state: string };
				status = c.execution_state;
				if (status === "idle") break;
			} else if (t === "error") {
				const c = incoming.content as { ename: string; evalue: string };
				console.error(`kernel error: ${c.ename}: ${c.evalue}`);
				break;
			}
		}
		return { stdout, status };
	}

	console.log("--- request 1 ---");
	const r1 = await execute(`print("hello from kernel"); x = 42`);
	console.log(`stdout: ${JSON.stringify(r1.stdout)} status=${r1.status}`);

	console.log("--- request 2 (state persistence) ---");
	const r2 = await execute(`print(x * 2)`);
	console.log(`stdout: ${JSON.stringify(r2.stdout)} status=${r2.status}`);

	// Pass criteria
	const got1 = r1.stdout.join("").trim();
	const got2 = r2.stdout.join("").trim();
	const pass = got1 === "hello from kernel" && got2 === "84";
	if (pass) {
		console.log("\nPASS: TS↔IPython kernel round-trip works, state persists.");
	} else {
		console.log("\nFAIL");
		console.log(`  expected stdout1='hello from kernel', got '${got1}'`);
		console.log(`  expected stdout2='84',                got '${got2}'`);
	}

	shell.close();
	iopub.close();
	cleanup();
	process.exit(pass ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
