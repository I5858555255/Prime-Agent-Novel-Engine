import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { createHarness, type Harness } from "../harness.js";

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");

describe("#1124 resumed session cwd", () => {
	let harness: Harness | undefined;
	let supervisor: ChildProcess | undefined;
	let client: DaemonClient | undefined;
	let supervisorStderr = "";

	afterEach(async () => {
		if (client) {
			try {
				await client.request({ type: "shutdown" }, 2000);
			} catch {
				// The supervisor may already be gone after a failed assertion.
			}
			client.close();
			client = undefined;
		}
		if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
			supervisor.kill("SIGTERM");
			await waitForExit(supervisor);
		}
		supervisor = undefined;
		harness?.cleanup();
		harness = undefined;
		supervisorStderr = "";
	});

	it("uses the saved cwd when the daemon was launched elsewhere", async () => {
		harness = await createHarness({ persistSession: true });
		harness.sessionManager.flushNow();
		const sessionPath = harness.sessionManager.materializeSessionFile();
		const savedCwd = harness.tempDir;
		const daemonCwd = join(harness.tempDir, "daemon-launch");
		const agentDir = join(harness.tempDir, "agent");
		const socketPath = join(tmpdir(), `prime-1124-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(daemonCwd, { recursive: true });

		supervisor = spawn(
			process.execPath,
			[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
			{
				cwd: daemonCwd,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../../tsconfig.json"),
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		supervisor.stderr?.on("data", (chunk: Buffer) => {
			supervisorStderr += chunk.toString("utf8");
		});

		client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath,
			config: { agentDir, noTools: true, noExtensions: true },
		});
		if (!created.success) {
			throw new Error(created.error);
		}

		const summary = created.data as SessionSummary;
		expect(summary.cwd).toBe(savedCwd);
		expect(summary.cwd).not.toBe(daemonCwd);
	}, 30_000);

	async function connectEventually(socketPath: string, child: ChildProcess): Promise<DaemonClient> {
		const deadline = Date.now() + 15_000;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(
					`Supervisor exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})\n${supervisorStderr}`,
				);
			}
			const candidate = new DaemonClient(socketPath);
			try {
				await candidate.connect(250);
				await candidate.waitForHello(1000);
				return candidate;
			} catch (error) {
				lastError = error;
				candidate.close();
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			}
		}
		throw new Error(`Timed out waiting for supervisor: ${String(lastError)}\n${supervisorStderr}`);
	}

	async function waitForExit(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		await new Promise<void>((resolveExit) => {
			const timeout = setTimeout(resolveExit, 5000);
			child.once("exit", () => {
				clearTimeout(timeout);
				resolveExit();
			});
		});
	}
});
