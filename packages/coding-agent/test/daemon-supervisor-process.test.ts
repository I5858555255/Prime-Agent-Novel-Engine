import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { readActiveOrphanProcessPids } from "../src/core/orphan-process-journal.js";
import {
	acquireSessionLease,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const workerPids = new Set<number>();
const daemonSockets = new Set<string>();
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

afterEach(async () => {
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.request({ type: "shutdown" }, 2000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
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
				// Already gone.
			}
		}
	}
	workerPids.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-daemon-supervisor-test-"));
	tempDirs.push(directory);
	return directory;
}

function spawnSupervisor(
	agentDir: string,
	socketPath: string,
	cwd: string,
	extraArgs: readonly string[] = [],
): ChildProcess {
	daemonSockets.add(socketPath);
	const child = spawn(
		process.execPath,
		[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline", ...extraArgs],
		{
			cwd,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(child);
	const diagnostics = { stdout: "", stderr: "" };
	childDiagnostics.set(child, diagnostics);
	child.stdout?.on("data", (chunk: Buffer) => {
		diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		diagnostics.stderr += chunk.toString("utf8");
	});
	return child;
}

function readDaemonLogs(agentDir: string): string {
	const logsDir = join(agentDir, "logs");
	try {
		return readdirSync(logsDir)
			.map((name) => `${name}:\n${readFileSync(join(logsDir, name), "utf8")}`)
			.join("\n");
	} catch {
		return "no daemon logs";
	}
}

function readWorkerDescriptor(agentDir: string): DaemonWorkerDescriptor {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const descriptorDirectory = join(workersRoot, directory);
		for (const name of readdirSync(descriptorDirectory)) {
			if (name.endsWith(".json")) {
				return JSON.parse(readFileSync(join(descriptorDirectory, name), "utf8")) as DaemonWorkerDescriptor;
			}
		}
	}
	throw new Error("Worker descriptor was not persisted");
}

function readSupervisorConfig(agentDir: string): { defaultSessionConfig?: { sessionDir?: string; noTools?: boolean } } {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const path = join(workersRoot, directory, "supervisor-config");
		try {
			return JSON.parse(readFileSync(path, "utf8")) as {
				defaultSessionConfig?: { sessionDir?: string; noTools?: boolean };
			};
		} catch {
			// Continue looking for the descriptor directory for this daemon socket.
		}
	}
	throw new Error("Supervisor config was not persisted");
}

async function connectEventually(socketPath: string, child?: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child && (child.exitCode !== null || child.signalCode !== null)) {
			throw new Error(
				`Supervisor exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`,
			);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
	}
	throw new Error(`Timed out waiting for supervisor: ${String(lastError)}`);
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

function requireSummary(responseData: unknown): SessionSummary {
	if (!responseData || typeof responseData !== "object") {
		throw new Error("Missing daemon session summary");
	}
	return responseData as SessionSummary;
}

function requireSessionList(responseData: unknown): SessionSummary[] {
	if (!responseData || typeof responseData !== "object" || !("sessions" in responseData)) {
		throw new Error("Missing daemon session list");
	}
	const sessions = (responseData as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Invalid daemon session list");
	}
	return sessions as SessionSummary[];
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	await new Promise<void>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for process exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
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

describe("daemon supervisor resident workers", () => {
	it("restarts an empty supervisor without requiring a resident worker", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(root, "custom-sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-restart-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir, ["--session-dir", sessionDir, "--no-tools"]);
		const client = await connectEventually(socketPath, supervisor);
		const restarted = await client.request({ type: "restart" });
		expect(restarted.success).toBe(true);
		client.close();
		await waitForExit(supervisor);
		children.delete(supervisor);

		const replacementClient = await connectEventually(socketPath);
		const listed = await replacementClient.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(readSupervisorConfig(agentDir)).toMatchObject({
			defaultSessionConfig: { sessionDir, noTools: true },
		});
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
	});

	it("hosts ten resident roots in ten isolated worker processes without a session cap", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-ten-roots-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionFiles = Array.from({ length: 10 }, (_, index) => {
			const manager = SessionManager.create(projectDir, sessionDir);
			manager.appendMessage({ role: "user", content: `root ${index}`, timestamp: index + 1 });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Fixture session did not persist");
			}
			return sessionFile;
		});

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const externalLease = acquireSessionLease(sessionFiles[0], agentDir, {
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: "external-owner",
		});
		const conflict = await client.request({
			type: "create",
			sessionPath: sessionFiles[0],
			config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
		});
		expect(conflict).toMatchObject({
			success: false,
			errorInfo: { code: "session_already_active", activeSessionId: "external-owner" },
		});
		const emptyAfterConflict = await client.request({ type: "list" });
		expect(requireSessionList(emptyAfterConflict.success ? emptyAfterConflict.data : undefined)).toHaveLength(0);
		externalLease?.release();
		const created = await Promise.all(
			sessionFiles.map((sessionPath) =>
				client.request({
					type: "create",
					sessionPath,
					config: { cwd: projectDir, agentDir, sessionDir, noTools: true, noExtensions: true },
				}),
			),
		);
		const summaries = created.map((response) => {
			if (!response.success) {
				throw new Error(response.error);
			}
			return requireSummary(response.data);
		});
		const pids = summaries.map((summary) => summary.workerPid);
		expect(new Set(pids).size).toBe(10);
		expect(pids).not.toContain(supervisor.pid);
		for (const pid of pids) {
			if (!pid) {
				throw new Error("Resident root did not expose a worker pid");
			}
			workerPids.add(pid);
		}
		const firstActiveSessionId = summaries[0]!.activeSessionId ?? summaries[0]!.id;
		const addedCron = await client.request({
			type: "cron_add",
			activeSessionId: firstActiveSessionId,
			schedule: "every 1h",
			prompt: "check status",
		});
		expect(addedCron.success).toBe(true);
		const cronJob = (addedCron.success ? addedCron.data : undefined) as { job?: { id?: string } } | undefined;
		if (!cronJob?.job?.id) {
			throw new Error("Supervisor did not persist the cron job");
		}
		const listedCron = await client.request({ type: "cron_list", activeSessionId: firstActiveSessionId });
		expect(listedCron).toMatchObject({ success: true, data: { jobs: [{ id: cronJob.job.id }] } });
		const cancelledCron = await client.request({ type: "cron_cancel", jobId: cronJob.job.id });
		expect(cancelledCron.success).toBe(true);

		const listed = await client.request({ type: "list" });
		expect(listed.success).toBe(true);
		expect(requireSessionList(listed.success ? listed.data : undefined)).toHaveLength(10);
		supervisor.kill("SIGTERM");
		await waitForExit(supervisor);
		children.delete(supervisor);
		client.close();
		const replacementClient = await connectEventually(socketPath);
		const adopted = await replacementClient.request({ type: "list" });
		expect(adopted.success).toBe(true);
		expect(
			new Set(requireSessionList(adopted.success ? adopted.data : undefined).map((summary) => summary.workerPid)),
		).toEqual(new Set(pids));
		await replacementClient.request({ type: "shutdown" });
		replacementClient.close();
		await waitForSocketGone(socketPath);
		await Promise.all(
			pids.map(async (pid) => {
				if (pid) {
					await waitForProcessGone(pid);
					workerPids.delete(pid);
				}
			}),
		);
	}, 60_000);

	it("isolates a root, streams a chunked snapshot, and adopts the same worker after restart", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = join(tmpdir(), `prime-supervisor-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
		mkdirSync(projectDir, { recursive: true });
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		const largePrompt = `large:${"x".repeat(600 * 1024)}`;
		sessionManager.appendMessage({ role: "user", content: largePrompt, timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "openai-responses",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session did not persist");
		}

		const firstSupervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, firstSupervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: {
				cwd: projectDir,
				agentDir,
				sessionDir,
				noTools: true,
				noExtensions: true,
			},
		});
		if (!created.success) {
			const diagnostics = childDiagnostics.get(firstSupervisor);
			throw new Error(
				`${created.error}\nsupervisor stdout:\n${diagnostics?.stdout ?? ""}\nsupervisor stderr:\n${diagnostics?.stderr ?? ""}\n${readDaemonLogs(agentDir)}`,
			);
		}
		expect(created.success).toBe(true);
		const createdSummary = requireSummary(created.data);
		expect(createdSummary.workerState).toBe("ready");
		expect(createdSummary.workerPid).not.toBe(firstSupervisor.pid);
		if (!createdSummary.workerPid) {
			throw new Error("Resident worker did not expose its pid");
		}
		workerPids.add(createdSummary.workerPid);

		const connection = await DaemonAgentConnection.attach(
			client,
			createdSummary.activeSessionId ?? createdSummary.id,
			{ recoverDaemon: async () => {} },
		);
		const connectionEvents: string[] = [];
		const replacementMessageCounts: number[] = [];
		connection.subscribe((event) => {
			connectionEvents.push(event.type === "connection_status" ? `${event.type}:${event.status}` : event.type);
			if (event.type === "session_replaced") {
				replacementMessageCounts.push(event.messages.length);
			}
		});
		const snapshot = await connection.getInitialSnapshot();
		expect(snapshot.messages).toHaveLength(2);
		expect(snapshot.messages[0]).toMatchObject({ role: "user", content: largePrompt });

		const activeSessionId = createdSummary.activeSessionId ?? createdSummary.id;
		const createdNew = await client.request({ type: "new_session", activeSessionId });
		expect(createdNew.success).toBe(true);
		const emptyReplacementDeadline = Date.now() + 5000;
		while (!replacementMessageCounts.includes(0) && Date.now() < emptyReplacementDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(replacementMessageCounts).toContain(0);
		const switchedBack = await client.request({ type: "switch_session", activeSessionId, sessionPath: sessionFile });
		expect(switchedBack.success).toBe(true);
		const restoredReplacementDeadline = Date.now() + 5000;
		while (replacementMessageCounts.at(-1) !== 2 && Date.now() < restoredReplacementDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		expect(replacementMessageCounts.at(-1)).toBe(2);

		firstSupervisor.kill("SIGTERM");
		await waitForExit(firstSupervisor);
		children.delete(firstSupervisor);

		const reconnectDeadline = Date.now() + 15_000;
		while (!connectionEvents.includes("connection_status:connected") && Date.now() < reconnectDeadline) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		expect(connectionEvents).toContain("connection_status:reconnecting");
		expect(connectionEvents).toContain("connection_status:connected");
		expect(connectionEvents).not.toContain("closed");
		await expect(connection.getState()).resolves.toMatchObject({
			activeSessionId: createdSummary.activeSessionId,
			sessionId: createdSummary.sessionId,
		});
		const listed = await client.request({ type: "list", all: true, sessionDir });
		expect(listed.success).toBe(true);
		if (!listed.success) {
			throw new Error(listed.error);
		}
		const adopted = requireSessionList(listed.data).find(
			(summary) => (summary.activeSessionId ?? summary.id) === (createdSummary.activeSessionId ?? createdSummary.id),
		);
		expect(adopted).toMatchObject({
			workerState: "ready",
			workerPid: createdSummary.workerPid,
		});

		const descriptor = readWorkerDescriptor(agentDir);
		const bashStarted = await client.request({
			type: "execute_bash",
			activeSessionId,
			command: "sleep 60",
		});
		expect(bashStarted.success).toBe(true);
		if (!descriptor.orphanProcessJournalPath) {
			throw new Error("Resident worker did not persist its orphan-process journal path");
		}
		let orphanPids: number[] = [];
		const orphanDeadline = Date.now() + 5000;
		while (orphanPids.length === 0 && Date.now() < orphanDeadline) {
			orphanPids = readActiveOrphanProcessPids(descriptor.orphanProcessJournalPath, descriptor.pid);
			if (orphanPids.length === 0) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
		expect(orphanPids.length).toBeGreaterThan(0);
		for (const pid of orphanPids) {
			workerPids.add(pid);
		}
		process.kill(createdSummary.workerPid, "SIGKILL");
		await waitForProcessGone(createdSummary.workerPid);
		workerPids.delete(createdSummary.workerPid);
		await Promise.all(orphanPids.map((pid) => waitForProcessGone(pid)));
		for (const pid of orphanPids) {
			workerPids.delete(pid);
		}

		let recovered: SessionSummary | undefined;
		const recoveryDeadline = Date.now() + 20_000;
		while (Date.now() < recoveryDeadline) {
			const response = await client.request({ type: "list" });
			if (response.success) {
				recovered = requireSessionList(response.data).find(
					(summary) =>
						(summary.activeSessionId ?? summary.id) === (createdSummary.activeSessionId ?? createdSummary.id),
				);
				if (recovered?.workerState === "ready" && recovered.workerPid !== createdSummary.workerPid) {
					break;
				}
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
		expect(recovered).toMatchObject({ workerState: "ready", activeSessionId: createdSummary.activeSessionId });
		if (!recovered?.workerPid) {
			throw new Error("Recovered worker did not expose its pid");
		}
		workerPids.add(recovered.workerPid);
		expect(readFileSync(sessionFile, "utf8")).toContain("prime-agent.worker_recovery");
		await expect(connection.getState()).resolves.toMatchObject({ sessionId: createdSummary.sessionId });

		await connection.dispose();
		await client.request({ type: "shutdown" });
		client.close();
		await waitForSocketGone(socketPath);
		await waitForProcessGone(recovered.workerPid);
		workerPids.delete(recovered.workerPid);
	});
});
