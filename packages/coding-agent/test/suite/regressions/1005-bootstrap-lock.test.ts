import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireBootstrapLock } from "../../../src/core/kernel/bootstrap.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rm: vi.fn(actual.rm) };
});

let tempDir = "";
let venv = "";
let lockDir = "";
let passthroughRm: typeof rm;

function deadProcessPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		child.on("error", reject);
		child.on("exit", () => {
			if (child.pid === undefined) {
				reject(new Error("child pid unavailable"));
				return;
			}
			resolve(child.pid);
		});
	});
}

function writeLockPid(pid: number): void {
	mkdirSync(lockDir, { recursive: true });
	writeFileSync(join(lockDir, "pid"), `${pid}\n`);
}

describe("bootstrap lock race", () => {
	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-bootstrap-lock-"));
		venv = join(tempDir, "kernel-venv");
		lockDir = `${venv}.bootstrap.lock`;
		passthroughRm = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm;
		vi.mocked(rm).mockClear();
		vi.mocked(rm).mockImplementation(passthroughRm);
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("serializes concurrent acquires on the same venv", async () => {
		const releaseFirst = await acquireBootstrapLock(venv);

		let secondAcquired = false;
		const second = acquireBootstrapLock(venv).then((release) => {
			secondAcquired = true;
			return release;
		});

		await sleep(250);
		expect(secondAcquired).toBe(false);

		await releaseFirst();
		const releaseSecond = await second;
		expect(secondAcquired).toBe(true);
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));

		await releaseSecond();
		expect(existsSync(lockDir)).toBe(false);
	});

	it("reclaims a lock left by a dead process", async () => {
		writeLockPid(await deadProcessPid());

		const release = await acquireBootstrapLock(venv);
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
		expect(
			readdirSync(tempDir).filter((entry) => entry.includes(".candidate-") || entry.includes(".stale-")),
		).toEqual([]);

		await release();
	});

	it("does not destroy a live lock created while reclaiming a stale lock", async () => {
		writeLockPid(await deadProcessPid());

		let injectedLiveLock = false;
		vi.mocked(rm).mockImplementation(async (target, options) => {
			if (!injectedLiveLock && String(target).includes(".stale-")) {
				injectedLiveLock = true;
				// A live holder creates a fresh lock between the stale rename-aside and the rm.
				writeLockPid(process.pid);
				writeFileSync(join(lockDir, "marker"), "live");
			}
			return passthroughRm(target, options);
		});

		const acquirePromise = acquireBootstrapLock(venv);
		await vi.waitFor(() => expect(injectedLiveLock).toBe(true));
		await sleep(250);

		// Reclaim must never remove the lock directory itself.
		expect(vi.mocked(rm).mock.calls.some(([target]) => String(target) === lockDir)).toBe(false);
		expect(readFileSync(join(lockDir, "marker"), "utf8")).toBe("live");

		rmSync(lockDir, { recursive: true, force: true });
		const release = await acquirePromise;
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
		await release();
	});
});
