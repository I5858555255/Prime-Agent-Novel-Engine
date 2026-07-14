import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.js";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import {
	DAEMON_SUPERVISOR_REGISTRY_DIR_ENV,
	listDaemonSupervisorOwners,
	mutateDaemonSupervisorOwner,
	persistDaemonStartupFence,
	readDaemonSupervisorOwner,
} from "../../../src/modes/daemon/daemon-supervisor-ownership.js";
import { createHarness, type Harness } from "../harness.js";

type FixtureMessage =
	| { type: "booted" }
	| { type: "ready"; generation?: string }
	| { type: "failed"; error: string }
	| { type: "phase"; phase: string }
	| { type: "path_released" }
	| { type: "cleanup_complete"; skipped: boolean };

interface FixtureHandle {
	child: ChildProcess;
	diagnostics: { stdout: string; stderr: string };
	messages: FixtureMessage[];
	waiters: Array<{
		predicate: (message: FixtureMessage) => boolean;
		resolve: (message: FixtureMessage) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>;
}

const fixturePath = resolve(__dirname, "../../fixtures/eng-4600-supervisor-fixture.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const tsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const handles = new Set<FixtureHandle>();
const harnesses: Harness[] = [];

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
});

function dispatchMessage(handle: FixtureHandle, message: FixtureMessage): void {
	const waiterIndex = handle.waiters.findIndex((waiter) => waiter.predicate(message));
	if (waiterIndex === -1) {
		handle.messages.push(message);
		return;
	}
	const [waiter] = handle.waiters.splice(waiterIndex, 1);
	if (!waiter) {
		return;
	}
	clearTimeout(waiter.timeout);
	waiter.resolve(message);
}

function spawnFixture(
	mode: "legacy" | "owner" | "supervisor",
	paths: { agentDir: string; descriptorDir: string; registryDir: string; socketPath: string },
	options: { failPhase?: string; generation?: string; pausePhase?: string } = {},
): FixtureHandle {
	const child = spawn(process.execPath, [tsxPath, fixturePath], {
		cwd: paths.agentDir,
		env: {
			...process.env,
			[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV]: paths.registryDir,
			[ENV_AGENT_DIR]: paths.agentDir,
			ENG_4600_AGENT_DIR: paths.agentDir,
			ENG_4600_DESCRIPTOR_DIR: paths.descriptorDir,
			ENG_4600_FAIL_PHASE: options.failPhase,
			ENG_4600_FIXTURE_MODE: mode,
			ENG_4600_GENERATION: options.generation,
			ENG_4600_PAUSE_PHASE: options.pausePhase,
			ENG_4600_REGISTRY_DIR: paths.registryDir,
			ENG_4600_SOCKET_PATH: paths.socketPath,
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: tsconfigPath,
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const handle: FixtureHandle = {
		child,
		diagnostics: { stdout: "", stderr: "" },
		messages: [],
		waiters: [],
	};
	handles.add(handle);
	child.stdout?.on("data", (chunk: Buffer) => {
		handle.diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		handle.diagnostics.stderr += chunk.toString("utf8");
	});
	child.on("message", (message: FixtureMessage) => dispatchMessage(handle, message));
	return handle;
}

function waitForMessage(
	handle: FixtureHandle,
	predicate: (message: FixtureMessage) => boolean,
	timeoutMs = 20_000,
): Promise<FixtureMessage> {
	const queuedIndex = handle.messages.findIndex(predicate);
	if (queuedIndex !== -1) {
		const [message] = handle.messages.splice(queuedIndex, 1);
		if (message) {
			return Promise.resolve(message);
		}
	}
	return new Promise((resolveMessage, rejectMessage) => {
		const timeout = setTimeout(() => {
			handle.waiters = handle.waiters.filter((waiter) => waiter.timeout !== timeout);
			rejectMessage(
				new Error(
					`Timed out waiting for fixture message (exit=${handle.child.exitCode}/${handle.child.signalCode})\n${handle.diagnostics.stderr}`,
				),
			);
		}, timeoutMs);
		handle.waiters.push({ predicate, resolve: resolveMessage, reject: rejectMessage, timeout });
	});
}

function waitForType<T extends FixtureMessage["type"]>(
	handle: FixtureHandle,
	type: T,
	timeoutMs?: number,
): Promise<Extract<FixtureMessage, { type: T }>> {
	return waitForMessage(handle, (message) => message.type === type, timeoutMs) as Promise<
		Extract<FixtureMessage, { type: T }>
	>;
}

function waitForExit(handle: FixtureHandle, timeoutMs = 20_000): Promise<void> {
	if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(
			() => rejectExit(new Error(`Timed out waiting for fixture exit\n${handle.diagnostics.stderr}`)),
			timeoutMs,
		);
		handle.child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

function send(handle: FixtureHandle, type: "cleanup" | "go" | "resume" | "shutdown"): void {
	handle.child.send({ type });
}

async function createPaths(): Promise<{
	agentDir: string;
	descriptorDir: string;
	registryDir: string;
	socketPath: string;
}> {
	const harness = await createHarness();
	harnesses.push(harness);
	return {
		agentDir: harness.tempDir,
		descriptorDir: join(harness.tempDir, "workers"),
		registryDir: join(harness.tempDir, "registry"),
		socketPath:
			process.platform === "win32"
				? `\\\\.\\pipe\\prime-agent-eng-4600-${process.pid}-${Date.now()}`
				: join(harness.tempDir, "daemon.sock"),
	};
}

async function assertConnectable(socketPath: string): Promise<void> {
	await new Promise<void>((resolveConnect, rejectConnect) => {
		const socket = createConnection(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolveConnect();
		});
		socket.once("error", rejectConnect);
	});
}

async function stopSupervisor(handle: FixtureHandle, socketPath: string): Promise<void> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
		await client.waitForHello(2000);
		await client.request({ type: "shutdown" }, 5000);
	} finally {
		client.close();
	}
	await waitForExit(handle);
}

describe("ENG-4600 daemon supervisor ownership", () => {
	it("elects one listener while 16 contenders atomically reclaim a stale owner", async () => {
		const paths = await createPaths();
		const stale = spawnFixture("owner", paths, { generation: "stale-owner" });
		await waitForType(stale, "booted");
		send(stale, "go");
		await waitForType(stale, "ready");
		stale.child.kill("SIGKILL");
		await waitForExit(stale);

		const contenders = Array.from({ length: 16 }, () => spawnFixture("supervisor", paths));
		await Promise.all(contenders.map((contender) => waitForType(contender, "booted")));
		for (const contender of contenders) {
			send(contender, "go");
		}
		const outcomes = await Promise.all(
			contenders.map((contender) =>
				waitForMessage(contender, (message) => message.type === "ready" || message.type === "failed", 30_000),
			),
		);
		expect(outcomes.filter((message) => message.type === "ready")).toHaveLength(1);
		expect(outcomes.filter((message) => message.type === "failed")).toHaveLength(15);
		const winner = contenders[outcomes.findIndex((message) => message.type === "ready")];
		if (!winner) {
			throw new Error("No supervisor contender won ownership");
		}
		await assertConnectable(paths.socketPath);
		const [owner] = await listDaemonSupervisorOwners(paths.registryDir);
		expect(owner).toBeDefined();
		if (!owner) {
			throw new Error("Winning supervisor did not publish an owner record");
		}
		expect(await readDaemonSupervisorOwner(owner.generation, paths.registryDir)).toEqual(owner);
		expect(
			await mutateDaemonSupervisorOwner(owner.generation, "wrong-token", () => undefined, paths.registryDir),
		).toBeUndefined();
		expect(
			await mutateDaemonSupervisorOwner(
				owner.generation,
				owner.token,
				(record) => {
					record.phase = "owner";
				},
				paths.registryDir,
			),
		).toMatchObject({ generation: owner.generation, phase: "owner" });
		await stopSupervisor(winner, paths.socketPath);
		expect(await listDaemonSupervisorOwners(paths.registryDir)).toEqual([]);
	}, 60_000);

	it("blocks delayed v0.3 cleanup from unlinking the replacement socket", async () => {
		if (process.platform === "win32") {
			return;
		}
		const paths = await createPaths();
		const legacy = spawnFixture("legacy", paths);
		await waitForType(legacy, "booted");
		await waitForType(legacy, "ready");
		send(legacy, "shutdown");
		await waitForType(legacy, "path_released");

		const replacement = spawnFixture("supervisor", paths, { pausePhase: "socket_lock" });
		await waitForType(replacement, "booted");
		send(replacement, "go");
		await waitForMessage(replacement, (message) => message.type === "phase" && message.phase === "socket_lock");
		send(replacement, "resume");
		await waitForMessage(replacement, (message) => message.type === "phase" && message.phase === "bind");
		send(legacy, "cleanup");
		const cleanup = await waitForType(legacy, "cleanup_complete");
		expect(cleanup.skipped).toBe(true);
		await waitForType(replacement, "ready");
		await assertConnectable(paths.socketPath);
		await stopSupervisor(replacement, paths.socketPath);
	}, 30_000);

	it("waits for the exact persisted predecessor identity during update handoff", async () => {
		if (process.platform === "win32") {
			return;
		}
		const paths = await createPaths();
		const legacy = spawnFixture("legacy", paths);
		await waitForType(legacy, "booted");
		await waitForType(legacy, "ready");
		const predecessorPid = legacy.child.pid;
		if (!predecessorPid) {
			throw new Error("Legacy fixture has no process id");
		}
		await persistDaemonStartupFence(
			paths.socketPath,
			{ pid: predecessorPid, processStartId: getProcessStartId(predecessorPid) },
			paths.registryDir,
		);

		const replacement = spawnFixture("supervisor", paths, { pausePhase: "socket_lock" });
		await waitForType(replacement, "booted");
		send(replacement, "go");
		await waitForMessage(replacement, (message) => message.type === "phase" && message.phase === "socket_lock");
		send(replacement, "resume");
		await expect(
			waitForMessage(replacement, (message) => message.type === "phase" && message.phase === "socket_prepare", 200),
		).rejects.toThrow(/Timed out/);

		send(legacy, "shutdown");
		await waitForType(legacy, "path_released");
		send(legacy, "cleanup");
		expect((await waitForType(legacy, "cleanup_complete")).skipped).toBe(true);
		await waitForExit(legacy);
		await waitForType(replacement, "ready");
		await assertConnectable(paths.socketPath);
		await stopSupervisor(replacement, paths.socketPath);
	}, 30_000);

	it("unwinds every fallible startup phase before another supervisor retries", async () => {
		const paths = await createPaths();
		const phases = [
			"owner",
			"socket_lock",
			"socket_prepare",
			"bind",
			"socket_restrict",
			"cache",
			"config",
			"journal",
			"descriptors",
			"catalog",
			"adoption",
			"ready",
		] as const;
		for (const phase of phases) {
			const failing = spawnFixture("supervisor", paths, { failPhase: phase });
			await waitForType(failing, "booted");
			send(failing, "go");
			const failure = await waitForType(failing, "failed");
			expect(failure.error).toContain(`Injected startup failure at ${phase}`);
			await waitForExit(failing);
			expect(await listDaemonSupervisorOwners(paths.registryDir)).toEqual([]);
			expect(existsSync(`${paths.socketPath}.lock`)).toBe(false);
			const cacheRoot = join(paths.descriptorDir, "snapshot-cache");
			expect(existsSync(cacheRoot) ? readdirSync(cacheRoot) : []).toEqual([]);
		}

		const healthy = spawnFixture("supervisor", paths);
		await waitForType(healthy, "booted");
		send(healthy, "go");
		await waitForType(healthy, "ready");
		await assertConnectable(paths.socketPath);
		await stopSupervisor(healthy, paths.socketPath);
	}, 120_000);
});
