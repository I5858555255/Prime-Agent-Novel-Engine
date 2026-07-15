import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME, ENV_AGENT_DIR } from "../../../src/config.js";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import {
	acquireDaemonShutdownAdmission,
	acquireDaemonSupervisorOwnership,
} from "../../../src/modes/daemon/daemon-supervisor-ownership.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { serializeJsonLine } from "../../../src/modes/rpc/jsonl.js";
import {
	encodePrivateFrame,
	type PrivateFrame,
	PrivateFrameDecoder,
} from "../../../src/modes/session-worker/private-framing.js";
import { createHarness, type Harness } from "../harness.js";

interface OwnerRecord {
	token: string;
	generation: string;
	pid: number;
	processStartId?: string;
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
}

type FixtureMessage =
	| { type: "booted" }
	| { type: "ready" }
	| { type: "failed"; error: string }
	| { type: "runtime_released" };

interface ProcessHandle {
	child: ChildProcess;
	stdout: string;
	stderr: string;
	messages: FixtureMessage[];
	waiters: Array<{
		predicate: (message: FixtureMessage) => boolean;
		resolve: (message: FixtureMessage) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>;
}

interface TestPaths {
	agentDir: string;
	descriptorDir: string;
	executablePath: string;
	registryDir: string;
	socketTmpDir: string;
	socketPath: string;
}

const fixturePath = resolve(__dirname, "../../fixtures/eng-4600-supervisor-fixture.ts");
const fauxExtensionPath = resolve(__dirname, "../../fixtures/eng-4600-faux-extension.ts");
const cliPath = resolve(__dirname, "../../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const supervisorRegistryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const handles = new Set<ProcessHandle>();
const harnesses: Harness[] = [];
const socketTempDirs = new Set<string>();

afterEach(async () => {
	for (const handle of handles) {
		if (handle.child.exitCode === null && handle.child.signalCode === null) {
			handle.child.kill("SIGKILL");
			await waitForExit(handle).catch(() => undefined);
		}
	}
	handles.clear();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
	for (const path of socketTempDirs) {
		rmSync(path, { recursive: true, force: true, maxRetries: 50, retryDelay: 50 });
	}
	socketTempDirs.clear();
});

async function createPaths(): Promise<TestPaths> {
	const harness = await createHarness();
	harnesses.push(harness);
	const executablePath = join(harness.tempDir, APP_NAME);
	linkSync(process.execPath, executablePath);
	const socketTmpDir = `/tmp/eng-4603-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	mkdirSync(socketTmpDir, { recursive: true, mode: 0o700 });
	socketTempDirs.add(socketTmpDir);
	return {
		agentDir: harness.tempDir,
		descriptorDir: join(harness.tempDir, "workers"),
		executablePath,
		registryDir: join(harness.tempDir, "registry"),
		socketTmpDir,
		socketPath:
			process.platform === "win32"
				? `\\\\.\\pipe\\prime-agent-eng-4603-${process.pid}-${Date.now()}`
				: join(harness.tempDir, "daemon.sock"),
	};
}

function spawnSupervisor(paths: TestPaths): ProcessHandle {
	return trackProcess(
		spawn(paths.executablePath, [tsxPath, fixturePath], {
			cwd: paths.agentDir,
			env: {
				...process.env,
				[supervisorRegistryDirEnv]: paths.registryDir,
				[ENV_AGENT_DIR]: paths.agentDir,
				ENG_4600_AGENT_DIR: paths.agentDir,
				ENG_4600_DESCRIPTOR_DIR: paths.descriptorDir,
				ENG_4600_FIXTURE_MODE: "supervisor",
				ENG_4600_REGISTRY_DIR: paths.registryDir,
				ENG_4600_SOCKET_PATH: paths.socketPath,
				PI_OFFLINE: "1",
				TMPDIR: paths.socketTmpDir,
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		}),
	);
}

function spawnStandaloneWorker(
	paths: TestPaths,
	workerSocketPath: string,
	token: string,
	extraEnv: NodeJS.ProcessEnv = {},
): ProcessHandle {
	return trackProcess(
		spawn(
			paths.executablePath,
			[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", workerSocketPath, "--offline"],
			{
				cwd: paths.agentDir,
				env: {
					...process.env,
					...extraEnv,
					[supervisorRegistryDirEnv]: paths.registryDir,
					[ENV_AGENT_DIR]: paths.agentDir,
					[DAEMON_WORKER_ROLE_ENV]: "1",
					[DAEMON_WORKER_TOKEN_ENV]: token,
					[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: "eng-4603-worker",
					[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: paths.socketPath,
					PI_OFFLINE: "1",
					TSX_TSCONFIG_PATH: tsconfigPath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		),
	);
}

function trackProcess(child: ChildProcess): ProcessHandle {
	const handle: ProcessHandle = { child, stdout: "", stderr: "", messages: [], waiters: [] };
	handles.add(handle);
	child.stdout?.on("data", (chunk: Buffer) => {
		handle.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		handle.stderr += chunk.toString("utf8");
	});
	child.on("message", (message: FixtureMessage) => {
		const index = handle.waiters.findIndex((waiter) => waiter.predicate(message));
		if (index === -1) {
			handle.messages.push(message);
			return;
		}
		const [waiter] = handle.waiters.splice(index, 1);
		if (waiter) {
			clearTimeout(waiter.timeout);
			waiter.resolve(message);
		}
	});
	return handle;
}

function waitForMessage(
	handle: ProcessHandle,
	predicate: (message: FixtureMessage) => boolean,
	timeoutMs = 30_000,
): Promise<FixtureMessage> {
	const index = handle.messages.findIndex(predicate);
	if (index !== -1) {
		return Promise.resolve(handle.messages.splice(index, 1)[0]!);
	}
	return new Promise((resolveMessage, rejectMessage) => {
		const timeout = setTimeout(() => {
			handle.waiters = handle.waiters.filter((waiter) => waiter.timeout !== timeout);
			rejectMessage(new Error(`Timed out waiting for fixture message\n${handle.stderr}`));
		}, timeoutMs);
		handle.waiters.push({ predicate, resolve: resolveMessage, timeout });
	});
}

function waitForType<T extends FixtureMessage["type"]>(
	handle: ProcessHandle,
	type: T,
	timeoutMs?: number,
): Promise<Extract<FixtureMessage, { type: T }>> {
	return waitForMessage(handle, (message) => message.type === type || message.type === "failed", timeoutMs)
		.then((message) => {
			if (message.type === "failed") throw new Error(message.error);
			return message as Extract<FixtureMessage, { type: T }>;
		})
		.catch((error: unknown) => {
			throw new Error(`Timed out waiting for fixture message ${type}: ${String(error)}`);
		});
}

function waitForExit(handle: ProcessHandle, timeoutMs = 30_000): Promise<void> {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(
			() => rejectExit(new Error(`Timed out waiting for process exit\n${handle.stderr}`)),
			timeoutMs,
		);
		handle.child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

async function waitForPath(path: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) {
		await delay(25);
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for ${path}`);
	}
}

async function connectEventually(socketPath: string): Promise<DaemonClient> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.waitForHello(2000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await delay(25);
		}
	}
	throw new Error(`Timed out connecting to supervisor: ${String(lastError)}`);
}

function listOwnerRecords(registryDir: string): OwnerRecord[] {
	if (!existsSync(registryDir)) {
		return [];
	}
	return readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => JSON.parse(readFileSync(join(registryDir, name, "owner.json"), "utf8")) as OwnerRecord);
}

function readWorkerDescriptor(descriptorDir: string): DaemonWorkerDescriptor {
	const descriptors = readdirSync(descriptorDir).filter((name) => name.endsWith(".json"));
	expect(descriptors).toHaveLength(1);
	return JSON.parse(readFileSync(join(descriptorDir, descriptors[0]!), "utf8")) as DaemonWorkerDescriptor;
}

function requireSummary(value: unknown): SessionSummary {
	if (!value || typeof value !== "object" || typeof (value as Partial<SessionSummary>).id !== "string") {
		throw new Error("Daemon returned an invalid session summary");
	}
	return value as SessionSummary;
}

function exactProcessIsAlive(pid: number, processStartId: string | undefined): boolean {
	if (!processStartId) {
		return false;
	}
	return getProcessStartId(pid) === processStartId;
}

async function waitForExactProcessExit(
	pid: number,
	processStartId: string | undefined,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (exactProcessIsAlive(pid, processStartId) && Date.now() < deadline) {
		await delay(25);
	}
	if (exactProcessIsAlive(pid, processStartId)) {
		throw new Error(`Timed out waiting for exact process ${pid}/${processStartId ?? "unknown"}`);
	}
}

async function createResidentSession(client: DaemonClient, agentDir: string): Promise<SessionSummary> {
	const response = await client.request(
		{
			type: "create",
			config: {
				agentDir,
				apiKey: "faux-key",
				cwd: agentDir,
				extensions: [fauxExtensionPath],
				model: "faux",
				noContextFiles: true,
				noExtensions: false,
				noSkills: true,
				noTools: true,
				provider: "faux",
			},
		},
		60_000,
	);
	if (!response.success) {
		throw new Error(response.error);
	}
	return requireSummary(response.data);
}

async function runCli(
	paths: TestPaths,
	args: string[],
	timeoutMs = 60_000,
	extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const handle = trackProcess(
		spawn(process.execPath, [tsxPath, cliPath, ...args], {
			cwd: paths.agentDir,
			env: {
				...process.env,
				...extraEnv,
				[supervisorRegistryDirEnv]: paths.registryDir,
				[ENV_AGENT_DIR]: paths.agentDir,
				PI_OFFLINE: "1",
				TMPDIR: paths.socketTmpDir,
				TSX_TSCONFIG_PATH: tsconfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
	await waitForExit(handle, timeoutMs);
	return { code: handle.child.exitCode ?? 0, stdout: handle.stdout, stderr: handle.stderr };
}

function createFrameReader(socket: Socket): {
	waitFor: (
		predicate: (frame: PrivateFrame<DaemonWorkerFrameHeader>) => boolean,
		timeoutMs?: number,
	) => Promise<PrivateFrame<DaemonWorkerFrameHeader>>;
} {
	const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
	const frames: PrivateFrame<DaemonWorkerFrameHeader>[] = [];
	const waiters: Array<{
		predicate: (frame: PrivateFrame<DaemonWorkerFrameHeader>) => boolean;
		resolve: (frame: PrivateFrame<DaemonWorkerFrameHeader>) => void;
		timeout: ReturnType<typeof setTimeout>;
	}> = [];
	socket.on("data", (chunk: Buffer) => {
		for (const frame of decoder.push(chunk)) {
			const index = waiters.findIndex((waiter) => waiter.predicate(frame));
			if (index === -1) {
				frames.push(frame);
				continue;
			}
			const waiter = waiters.splice(index, 1)[0];
			if (waiter) {
				clearTimeout(waiter.timeout);
				waiter.resolve(frame);
			}
		}
	});
	return {
		waitFor: (predicate, timeoutMs = 10_000) => {
			const index = frames.findIndex(predicate);
			if (index !== -1) {
				return Promise.resolve(frames.splice(index, 1)[0]!);
			}
			return new Promise((resolveFrame, rejectFrame) => {
				const timeout = setTimeout(() => {
					const waiterIndex = waiters.findIndex((waiter) => waiter.timeout === timeout);
					if (waiterIndex !== -1) waiters.splice(waiterIndex, 1);
					rejectFrame(new Error("Timed out waiting for worker frame"));
				}, timeoutMs);
				waiters.push({ predicate, resolve: resolveFrame, timeout });
			});
		},
	};
}

function decodeResponse(frame: PrivateFrame<DaemonWorkerFrameHeader>): DaemonResponse {
	return JSON.parse(frame.payload.toString("utf8")) as DaemonResponse;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe("ENG-4603 worker recovery convergence", () => {
	it("allows only the current generation to replace a crashed resident worker", async () => {
		if (process.platform === "win32") return;
		const paths = await createPaths();
		const predecessor = spawnSupervisor(paths);
		await waitForType(predecessor, "booted");
		predecessor.child.send({ type: "go" });
		await waitForType(predecessor, "ready", 60_000);
		const predecessorClient = await connectEventually(paths.socketPath);
		const summary = await createResidentSession(predecessorClient, paths.agentDir);
		const activeSessionId = summary.activeSessionId ?? summary.id;
		const originalWorkerPid = summary.workerPid;
		if (!originalWorkerPid) throw new Error("Resident worker did not expose its pid");
		const originalWorkerStartId = getProcessStartId(originalWorkerPid);

		predecessor.child.send({ type: "release_runtime" });
		await waitForType(predecessor, "runtime_released");
		process.kill(originalWorkerPid, "SIGKILL");
		const successor = spawnSupervisor(paths);
		await waitForType(successor, "booted");
		successor.child.send({ type: "go" });
		await waitForType(successor, "ready", 60_000);
		await waitForExactProcessExit(originalWorkerPid, originalWorkerStartId);

		const successorClient = await connectEventually(paths.socketPath);
		let replacement: DaemonWorkerDescriptor | undefined;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const candidate = readWorkerDescriptor(paths.descriptorDir);
			if (candidate.pid !== originalWorkerPid && candidate.lifecycle === "ready") {
				replacement = candidate;
				break;
			}
			await delay(25);
		}
		if (!replacement) throw new Error("Current supervisor did not publish a replacement worker");
		expect(getProcessStartId(replacement.pid)).toBe(replacement.processStartId);
		await delay(750);
		expect(exactProcessIsAlive(replacement.pid, replacement.processStartId)).toBe(true);
		expect(readdirSync(paths.descriptorDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
		const listed = await successorClient.request({ type: "list" });
		if (!listed.success) throw new Error(listed.error);
		const sessions = (listed.data as { sessions: unknown[] }).sessions;
		expect(sessions).toHaveLength(1);
		expect(requireSummary(sessions[0]).workerPid).toBe(replacement.pid);

		const connection = await DaemonAgentConnection.attach(successorClient, activeSessionId, {
			recoverDaemon: async () => {},
		});
		await connection.getInitialSnapshot();
		await connection.prompt("after recovery");
		await connection.waitForIdle();
		expect(await connection.getMessages()).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: [expect.objectContaining({ text: "upgrade response 1" })],
			}),
		);
		await connection.dispose();
		await successorClient.request({ type: "shutdown", force: true }, 10_000);
		successorClient.close();
		predecessorClient.close();
		await waitForExit(successor);
		predecessor.child.kill("SIGKILL");
		await waitForExit(predecessor);
	}, 120_000);

	it("rejects stale commands at worker receipt and before public journal insertion", async () => {
		if (process.platform === "win32") return;
		const workerPaths = await createPaths();
		const workerSocketPath = join(workerPaths.agentDir, "worker-command.sock");
		const token = "eng-4603-token";
		const psCountPath = join(workerPaths.agentDir, "ps-count");
		const workerEnvironment: NodeJS.ProcessEnv = {};
		if (process.platform === "darwin") {
			const psWrapperPath = join(workerPaths.agentDir, "ps");
			writeFileSync(psWrapperPath, '#!/bin/sh\nprintf x >> "$ENG_4603_PS_COUNT_PATH"\nexec /bin/ps "$@"\n', {
				mode: 0o700,
			});
			chmodSync(psWrapperPath, 0o700);
			workerEnvironment.ENG_4603_PS_COUNT_PATH = psCountPath;
			workerEnvironment.PATH = `${workerPaths.agentDir}:${process.env.PATH ?? ""}`;
		}
		const oldOwner = await acquireDaemonSupervisorOwnership({
			agentDir: workerPaths.agentDir,
			appVersion: "test",
			descriptorDir: workerPaths.descriptorDir,
			generation: "old-generation",
			registryDir: workerPaths.registryDir,
			socketPath: workerPaths.socketPath,
		});
		const worker = spawnStandaloneWorker(workerPaths, workerSocketPath, token, workerEnvironment);
		await waitForPath(workerSocketPath);
		const socket = createConnection(workerSocketPath);
		const frames = createFrameReader(socket);
		await new Promise<void>((resolveConnect, rejectConnect) => {
			socket.once("connect", resolveConnect);
			socket.once("error", rejectConnect);
		});
		await frames.waitFor((frame) => frame.header.kind === "outbound" && frame.header.outboundType === "daemon_hello");
		const authId = "auth-old";
		socket.write(
			encodePrivateFrame<DaemonWorkerFrameHeader>(
				{ kind: "command", requestId: authId, commandType: "worker_auth" },
				Buffer.from(
					serializeJsonLine({
						id: authId,
						type: "worker_auth",
						token,
						supervisorGeneration: oldOwner.record.generation,
						supervisorPid: oldOwner.record.pid,
						supervisorProcessStartId: oldOwner.record.processStartId,
						supervisorSocketPath: oldOwner.record.socketPath,
					}),
				),
			),
		);
		expect(
			decodeResponse(
				await frames.waitFor((frame) => frame.header.kind === "outbound" && frame.header.requestId === authId),
			).success,
		).toBe(true);
		if (process.platform === "darwin") {
			const countAfterAuthentication = readFileSync(psCountPath, "utf8").length;
			await delay(750);
			expect(readFileSync(psCountPath, "utf8").length).toBe(countAfterAuthentication);
			const ownerPath = join(workerPaths.registryDir, `${oldOwner.record.generation}.owner`, "owner.json");
			const ownerRecord = JSON.parse(readFileSync(ownerPath, "utf8")) as { updatedAt: string };
			ownerRecord.updatedAt = new Date(Date.now() + 1000).toISOString();
			const updatedOwnerPath = `${ownerPath}.updated`;
			writeFileSync(updatedOwnerPath, `${JSON.stringify(ownerRecord, null, 2)}\n`);
			renameSync(updatedOwnerPath, ownerPath);
			await delay(500);
			const countAfterOwnerChange = readFileSync(psCountPath, "utf8").length;
			expect(countAfterOwnerChange).toBeGreaterThan(countAfterAuthentication);
			await delay(750);
			expect(readFileSync(psCountPath, "utf8").length).toBe(countAfterOwnerChange);
		}
		const commandId = "stale-list";
		const commandFrame = encodePrivateFrame<DaemonWorkerFrameHeader>(
			{ kind: "command", requestId: commandId, commandType: "list" },
			Buffer.from(serializeJsonLine({ id: commandId, type: "list" })),
		);
		socket.write(commandFrame.subarray(0, commandFrame.length - 1));
		const ownerDirectory = join(workerPaths.registryDir, `${oldOwner.record.generation}.owner`);
		const ownerPath = join(ownerDirectory, "owner.json");
		const transitionedOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as OwnerRecord & { updatedAt: string };
		transitionedOwner.token = "successor-token";
		transitionedOwner.pid = worker.child.pid!;
		transitionedOwner.processStartId = getProcessStartId(worker.child.pid!);
		transitionedOwner.updatedAt = new Date().toISOString();
		const transitionedOwnerPath = `${ownerPath}.transitioned`;
		writeFileSync(transitionedOwnerPath, `${JSON.stringify(transitionedOwner, null, 2)}\n`);
		renameSync(transitionedOwnerPath, ownerPath);
		socket.write(commandFrame.subarray(commandFrame.length - 1));
		const staleResponse = decodeResponse(
			await frames.waitFor((frame) => frame.header.kind === "outbound" && frame.header.requestId === commandId),
		);
		expect(staleResponse).toMatchObject({ success: false, error: "supervisor_generation_stale" });
		socket.destroy();
		await oldOwner.release();
		rmSync(ownerDirectory, { recursive: true, force: true });
		worker.child.kill("SIGKILL");
		await waitForExit(worker);

		const publicPaths = await createPaths();
		const staleSupervisor = spawnSupervisor(publicPaths);
		await waitForType(staleSupervisor, "booted");
		staleSupervisor.child.send({ type: "go" });
		await waitForType(staleSupervisor, "ready", 60_000);
		const publicClient = await connectEventually(publicPaths.socketPath);
		const [publishedOwner] = listOwnerRecords(publicPaths.registryDir);
		if (!publishedOwner) throw new Error("Supervisor did not publish its owner");
		const journalPath = join(publicPaths.descriptorDir, "command-journal.jsonl");
		const journalBefore = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "";
		const displacedOwnerDir = join(publicPaths.registryDir, `${publishedOwner.generation}.displaced`);
		renameSync(join(publicPaths.registryDir, `${publishedOwner.generation}.owner`), displacedOwnerDir);
		const replacementOwner = await acquireDaemonSupervisorOwnership({
			agentDir: publicPaths.agentDir,
			appVersion: "test",
			descriptorDir: publicPaths.descriptorDir,
			generation: "journal-successor",
			registryDir: publicPaths.registryDir,
			socketPath: publicPaths.socketPath,
		});
		const rejected = await publicClient.request({ type: "create" });
		expect(rejected).toMatchObject({ success: false, error: expect.stringContaining("no longer owns") });
		expect(existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "").toBe(journalBefore);
		publicClient.close();
		await replacementOwner.release();
		rmSync(displacedOwnerDir, { recursive: true, force: true });
		staleSupervisor.child.kill("SIGKILL");
		await waitForExit(staleSupervisor);
	}, 90_000);

	it("serializes shutdown admission and reclaims an unrenewed live lease", async () => {
		const paths = await createPaths();
		const previousRegistryDir = process.env[supervisorRegistryDirEnv];
		process.env[supervisorRegistryDirEnv] = paths.registryDir;
		try {
			const first = await acquireDaemonShutdownAdmission();
			const record = JSON.parse(readFileSync(join(paths.registryDir, "shutdown-admission.json"), "utf8")) as {
				pid: number;
				processStartId?: string;
			};
			expect(record.pid).toBe(process.pid);
			expect(record.processStartId).toBe(getProcessStartId(process.pid));
			const refreshTimer = Reflect.get(first, "refreshTimer") as ReturnType<typeof setInterval> | undefined;
			if (!refreshTimer) throw new Error("Shutdown admission did not start its lease refresh");
			clearInterval(refreshTimer);
			let acquired = false;
			const waiting = acquireDaemonShutdownAdmission().then((admission) => {
				acquired = true;
				return admission;
			});
			await delay(250);
			expect(acquired).toBe(false);
			const second = await waiting;
			expect(acquired).toBe(true);
			let destructivePasses = 0;
			const destructivePass = async (admission: { assertOrRenew: () => Promise<void> }) => {
				await admission.assertOrRenew();
				destructivePasses++;
			};
			await expect(destructivePass(first)).rejects.toMatchObject({ code: "daemon_shutdown_in_progress" });
			await destructivePass(second);
			expect(destructivePasses).toBe(1);
			await second.release();
			await first.release();
		} finally {
			if (previousRegistryDir === undefined) {
				delete process.env[supervisorRegistryDirEnv];
			} else {
				process.env[supervisorRegistryDirEnv] = previousRegistryDir;
			}
		}
	}, 15_000);

	it("shutdown --all removes hidden supervisors and workers without changing CLI contracts", async () => {
		if (process.platform === "win32") return;
		const paths = await createPaths();
		const predecessor = spawnSupervisor(paths);
		await waitForType(predecessor, "booted");
		predecessor.child.send({ type: "go" });
		await waitForType(predecessor, "ready", 60_000);
		const client = await connectEventually(paths.socketPath);
		const session = await createResidentSession(client, paths.agentDir);
		const workerPid = session.workerPid;
		if (!workerPid) throw new Error("Resident worker did not expose its pid");
		const predecessorStartId = getProcessStartId(predecessor.child.pid!);
		const workerStartId = getProcessStartId(workerPid);
		predecessor.child.send({ type: "release_runtime" });
		await waitForType(predecessor, "runtime_released");
		const successor = spawnSupervisor(paths);
		await waitForType(successor, "booted");
		successor.child.send({ type: "go" });
		await waitForType(successor, "ready", 60_000);
		const successorStartId = getProcessStartId(successor.child.pid!);
		client.close();
		const lsofPath = join(paths.agentDir, "lsof");
		writeFileSync(lsofPath, '#!/bin/sh\nexec /usr/sbin/lsof -nP -F pn -U -a -p "$ENG_4603_LSOF_PIDS"\n', {
			mode: 0o700,
		});
		const lsofEnvironment = {
			ENG_4603_LSOF_PIDS: `${predecessor.child.pid},${successor.child.pid},${workerPid}`,
			PATH: `${paths.agentDir}:${process.env.PATH ?? ""}`,
		};
		const listenersBeforeShutdown = spawnSync(lsofPath, [], {
			encoding: "utf8",
			env: { ...process.env, ...lsofEnvironment },
		}).stdout;
		expect(listenersBeforeShutdown).toContain(`p${predecessor.child.pid}`);
		expect(listenersBeforeShutdown).toContain(`p${successor.child.pid}`);

		const shutdown = await runCli(paths, ["daemon", "shutdown", "--all", "--json"], 60_000, lsofEnvironment);
		expect(shutdown.code).toBe(0);
		const shutdownResult = JSON.parse(shutdown.stdout) as { stopped: unknown[]; failed: unknown[] };
		const survivingIdentities = [
			{ pid: predecessor.child.pid!, processStartId: predecessorStartId },
			{ pid: successor.child.pid!, processStartId: successorStartId },
			{ pid: workerPid, processStartId: workerStartId },
		].filter((identity) => exactProcessIsAlive(identity.pid, identity.processStartId));
		if (survivingIdentities.length > 0) {
			expect(shutdownResult.failed).not.toHaveLength(0);
		}
		expect(shutdownResult).toMatchObject({ stopped: expect.any(Array), failed: [] });
		await waitForExactProcessExit(predecessor.child.pid!, predecessorStartId);
		await waitForExactProcessExit(successor.child.pid!, successorStartId);
		await waitForExactProcessExit(workerPid, workerStartId);
		await delay(11_000);
		expect(exactProcessIsAlive(predecessor.child.pid!, predecessorStartId)).toBe(false);
		expect(exactProcessIsAlive(successor.child.pid!, successorStartId)).toBe(false);
		expect(exactProcessIsAlive(workerPid, workerStartId)).toBe(false);

		const contracts = [
			{ args: ["daemon", "ps", "--json"], json: [] },
			{ args: ["daemon", "ps", "--reap", "--json"], json: { reaped: [], skipped: [] } },
			{ args: ["daemon", "shutdown", "--all", "--json"], json: { stopped: [], failed: [] } },
		];
		for (const contract of contracts) {
			const result = await runCli(paths, contract.args, 60_000, lsofEnvironment);
			if (result.code !== 0) {
				throw new Error(`${contract.args.join(" ")} exited ${result.code}: ${result.stderr}`);
			}
			expect(JSON.parse(result.stdout)).toEqual(contract.json);
		}
		for (const args of [
			["daemon", "ps"],
			["daemon", "ps", "--reap"],
			["daemon", "shutdown", "--all"],
		]) {
			const result = await runCli(paths, args, 60_000, lsofEnvironment);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe("No daemons found.\n");
		}
	}, 150_000);
});
