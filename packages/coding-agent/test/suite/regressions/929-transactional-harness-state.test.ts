import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	getHarnessStateLockPath,
	getHarnessStatePath,
	loadHarnessState,
	saveHarnessState,
} from "../../../src/core/refinement/index.js";

const runtimeSrc = fileURLToPath(new URL("../../../../../prime-agent-runtime/src/", import.meta.url));
const python = process.env.PRIME_AGENT_KERNEL_PYTHON ?? "python3";
const tempRoots: string[] = [];

function memoryEntry(id: string, content: string) {
	const timestamp = new Date().toISOString();
	return {
		id,
		kind: "memory" as const,
		title: id,
		content,
		path: "general",
		scope: "local" as const,
		reference: {},
		arguments: {},
		metadata: {},
		source: "refine",
		created_at: timestamp,
		updated_at: timestamp,
		version: 1,
	};
}

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-929-"));
	tempRoots.push(root);
	return root;
}

function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const poll = (): void => {
			if (existsSync(path)) {
				resolve();
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`Timed out waiting for ${path}`));
				return;
			}
			setTimeout(poll, 10);
		};
		poll();
	});
}

function runPython(script: string, env: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(python, ["-c", script], {
			env: { ...process.env, PYTHONPATH: runtimeSrc, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Python exited ${code}: ${stderr}`));
		});
	});
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("issue #929 transactional harness state", () => {
	it("serializes Python mutations and rejects a stale TypeScript writer", async () => {
		const root = makeTempRoot();
		const statePath = getHarnessStatePath(root);
		const lockPath = getHarnessStateLockPath(root);
		const readyPath = join(root, "python-ready");
		const baseline = loadHarnessState(root, "local");
		saveHarnessState(root, baseline);
		const stale = loadHarnessState(root, "local");

		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner.json"),
			JSON.stringify({
				pid: process.pid,
				hostname: hostname(),
				token: "test-coordinator",
				created_at: new Date().toISOString(),
			}),
		);
		const pythonWrite = runPython(
			[
				"import os",
				"from pathlib import Path",
				"from rlm.harness import HarnessState",
				"Path(os.environ['READY_PATH']).write_text('ready', encoding='utf-8')",
				"HarnessState(os.environ['STATE_PATH']).create_memory('Python', 'kernel update', id='python')",
			].join("\n"),
			{ READY_PATH: readyPath, STATE_PATH: statePath },
		);
		await waitForFile(readyPath);
		expect(existsSync(lockPath)).toBe(true);
		rmSync(lockPath, { recursive: true });
		await pythonWrite;

		stale.entries.memory.typescript = memoryEntry("typescript", "stale host update");
		expect(() => saveHarnessState(root, stale)).toThrow(/revision conflict/);

		const committed = JSON.parse(readFileSync(statePath, "utf8"));
		expect(committed.revision).toBe(2);
		expect(committed.entries.memory.python.content).toBe("kernel update");
		expect(committed.entries.memory.typescript).toBeUndefined();
	});

	it("merges a Python mutation after both runtimes read the same revision", async () => {
		const root = makeTempRoot();
		const statePath = getHarnessStatePath(root);
		const readyPath = join(root, "python-loaded");
		const continuePath = join(root, "continue-python");
		const host = loadHarnessState(root, "local");
		saveHarnessState(root, host);
		const hostSnapshot = loadHarnessState(root, "local");
		const pythonWrite = runPython(
			[
				"import os, time",
				"from pathlib import Path",
				"from rlm.harness import HarnessState",
				"state = HarnessState(os.environ['STATE_PATH'])",
				"Path(os.environ['READY_PATH']).write_text('loaded', encoding='utf-8')",
				"while not Path(os.environ['CONTINUE_PATH']).exists(): time.sleep(0.01)",
				"state.create_memory('Python', 'merged kernel update', id='python')",
			].join("\n"),
			{ CONTINUE_PATH: continuePath, READY_PATH: readyPath, STATE_PATH: statePath },
		);
		await waitForFile(readyPath);

		hostSnapshot.entries.memory.typescript = memoryEntry("typescript", "committed host update");
		saveHarnessState(root, hostSnapshot);
		writeFileSync(continuePath, "continue");
		await pythonWrite;

		const committed = JSON.parse(readFileSync(statePath, "utf8"));
		expect(committed.revision).toBe(3);
		expect(committed.entries.memory.typescript.content).toBe("committed host update");
		expect(committed.entries.memory.python.content).toBe("merged kernel update");
	});

	it("reclaims a lock left by a crashed Python owner", async () => {
		const root = makeTempRoot();
		const statePath = getHarnessStatePath(root);
		const lockPath = getHarnessStateLockPath(root);
		await runPython(
			[
				"import json, os, socket",
				"from pathlib import Path",
				"lock = Path(os.environ['LOCK_PATH'])",
				"lock.mkdir()",
				"(lock / 'owner.json').write_text(json.dumps({'pid': os.getpid(), 'hostname': socket.gethostname(), 'token': 'crashed-owner'}), encoding='utf-8')",
				"os._exit(0)",
			].join("\n"),
			{ LOCK_PATH: lockPath },
		);

		const state = loadHarnessState(root, "local");
		expect(() => saveHarnessState(root, state)).not.toThrow();
		expect(existsSync(lockPath)).toBe(false);
		expect(JSON.parse(readFileSync(statePath, "utf8")).revision).toBe(1);
	});

	it("times out without stealing a live lock", () => {
		const root = makeTempRoot();
		const lockPath = getHarnessStateLockPath(root);
		mkdirSync(lockPath);
		writeFileSync(
			join(lockPath, "owner.json"),
			JSON.stringify({
				pid: process.pid,
				hostname: hostname(),
				token: "live-test-owner",
				created_at: new Date().toISOString(),
			}),
		);
		utimesSync(lockPath, 0, 0);

		const state = loadHarnessState(root, "local");
		expect(() => saveHarnessState(root, state, { lockTimeoutMs: 20, staleLockMs: 0 })).toThrow(
			/Timed out waiting for harness-state lock/,
		);
		expect(existsSync(lockPath)).toBe(true);
	});
});
