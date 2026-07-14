import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { DaemonOutbound } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { createHarness } from "../harness.js";

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const clients = new Set<DaemonClient>();

afterEach(() => {
	for (const client of clients) {
		client.close();
	}
	clients.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	children.clear();
	for (const pid of workerPids) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already stopped.
			}
		}
	}
	workerPids.clear();
});

function spawnSupervisor(agentDir: string, socketPath: string, cwd: string): ChildProcess {
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
		{
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	return child;
}

async function connectEventually(socketPath: string, child?: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 20_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			throw new Error(`Supervisor exited before becoming ready: ${child.exitCode ?? child.signalCode}`);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			clients.add(client);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`Timed out waiting for daemon supervisor: ${String(lastError)}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => rejectExit(new Error("Timed out waiting for supervisor exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function waitForSocketGone(socketPath: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(100);
		} catch {
			client.close();
			return;
		}
		client.close();
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error("Daemon supervisor socket remained available after shutdown");
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Worker ${pid} remained alive after daemon shutdown`);
}

function sessionList(data: unknown): SessionSummary[] {
	if (!data || typeof data !== "object" || !("sessions" in data)) {
		throw new Error("Daemon returned an invalid session list");
	}
	const sessions = (data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Daemon returned an invalid session list");
	}
	return sessions as SessionSummary[];
}

function daemonLogs(agentDir: string): string {
	try {
		return readdirSync(join(agentDir, "logs"))
			.map((name) => readFileSync(join(agentDir, "logs", name), "utf8"))
			.join("\n");
	} catch {
		return "";
	}
}

describe("ENG-4602 real-process snapshot transfer containment", () => {
	it("keeps a worker alive when its supervisor transport closes during a streamed snapshot", async () => {
		const harness = await createHarness({ persistSession: true });
		const agentDir = join(harness.tempDir, "agent");
		const sessionDir = join(harness.tempDir, "sessions");
		const socketPath = join(tmpdir(), `eng-4602-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		try {
			for (let index = 0; index < 64; index++) {
				harness.sessionManager.appendMessage({
					role: "user",
					content: `${index}:${"x".repeat(512 * 1024)}`,
					timestamp: index,
				});
			}
			const sessionFile = harness.sessionManager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Fixture session did not persist");
			}
			const supervisor = spawnSupervisor(agentDir, socketPath, harness.tempDir);
			const control = await connectEventually(socketPath, supervisor);
			const created = await control.request({
				type: "create",
				sessionPath: sessionFile,
				config: {
					cwd: harness.tempDir,
					agentDir,
					sessionDir,
					noTools: true,
					noExtensions: true,
				},
			});
			if (!created.success) {
				throw new Error(created.error);
			}
			const summary = created.data as SessionSummary;
			const activeSessionId = summary.activeSessionId ?? summary.id;
			if (!summary.workerPid) {
				throw new Error("Supervisor did not report a worker pid");
			}
			workerPids.add(summary.workerPid);
			const interrupted = await connectEventually(socketPath, supervisor);
			let interruptedSnapshotId: string | undefined;
			let resolveBegin = () => {};
			const began = new Promise<void>((resolveBeginPromise) => {
				resolveBegin = resolveBeginPromise;
			});
			const unsubscribe = interrupted.onMessage((message: DaemonOutbound) => {
				if (message.type !== "session_snapshot_begin" || message.activeSessionId !== activeSessionId) {
					return;
				}
				interruptedSnapshotId = message.snapshotId;
				resolveBegin();
				supervisor.kill("SIGTERM");
				interrupted.close();
			});
			void interrupted
				.request({
					type: "attach",
					activeSessionId,
					capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
				})
				.catch(() => undefined);
			await Promise.race([
				began,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("Snapshot stream did not begin")), 30_000),
				),
			]);
			unsubscribe();
			await waitForExit(supervisor);
			children.delete(supervisor);

			expect(() => process.kill(summary.workerPid!, 0)).not.toThrow();
			const replacement = await connectEventually(socketPath);
			let adopted: SessionSummary | undefined;
			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				const listed = await replacement.request({ type: "list" });
				if (listed.success) {
					adopted = sessionList(listed.data).find(
						(candidate) => (candidate.activeSessionId ?? candidate.id) === activeSessionId,
					);
					if (adopted?.workerState === "ready") {
						break;
					}
				}
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
			}
			expect(adopted).toMatchObject({ workerState: "ready", workerPid: summary.workerPid });
			let retrySnapshotId: string | undefined;
			let resolveRetryEnd = () => {};
			const retryEnded = new Promise<void>((resolveRetryEndPromise) => {
				resolveRetryEnd = resolveRetryEndPromise;
			});
			const unsubscribeRetry = replacement.onMessage((message: DaemonOutbound) => {
				if (!("activeSessionId" in message) || message.activeSessionId !== activeSessionId) {
					return;
				}
				if (message.type === "session_snapshot_begin") {
					retrySnapshotId = message.snapshotId;
				}
				if (message.type === "session_snapshot_end") {
					expect(message.snapshotId).toBe(interruptedSnapshotId);
					resolveRetryEnd();
				}
			});
			const retried = await replacement.request({
				type: "attach",
				activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			});
			if (!retried.success) {
				throw new Error(retried.error);
			}
			await Promise.race([
				retryEnded,
				new Promise<never>((_resolve, reject) =>
					setTimeout(() => reject(new Error("Fresh same-ID retry did not complete")), 30_000),
				),
			]);
			unsubscribeRetry();
			expect(interruptedSnapshotId).toBeDefined();
			expect(retrySnapshotId).toBe(interruptedSnapshotId);
			expect(daemonLogs(agentDir)).not.toContain("unhandled rejection");
			await replacement.request({ type: "shutdown", force: true });
			replacement.close();
			clients.delete(replacement);
			control.close();
			clients.delete(control);
			await waitForSocketGone(socketPath);
			await waitForProcessGone(summary.workerPid);
			workerPids.delete(summary.workerPid);
		} finally {
			harness.cleanup();
		}
	}, 90_000);
});
