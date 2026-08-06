import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discardVenvDir } from "../src/core/kernel/bootstrap.js";

let tempDir = "";

const binDir = process.platform === "win32" ? "Scripts" : "bin";
const executableName = process.platform === "win32" ? "python.exe" : "python";

function createVenv(): string {
	const venv = join(tempDir, "kernel-venv");
	mkdirSync(join(venv, binDir), { recursive: true });
	// A copy of the current node binary stands in for the venv interpreter: running
	// it produces the same mapped-image lock that a live kernel holds.
	copyFileSync(process.execPath, join(venv, binDir, executableName));
	writeFileSync(join(venv, ".bootstrap-version"), "{}\n");
	return venv;
}

function stagedDirs(venv: string): string[] {
	return readdirSync(tempDir).filter((entry) => entry !== basename(venv));
}

describe("kernel venv discard", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-venv-discard-"));
	});

	afterEach(() => {
		if (!tempDir) return;
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		tempDir = "";
	});

	it("removes an idle venv outright", async () => {
		const venv = createVenv();

		await discardVenvDir(venv);

		expect(existsSync(venv)).toBe(false);
		expect(stagedDirs(venv)).toEqual([]);
	});

	it("does nothing when the venv is already gone", async () => {
		await expect(discardVenvDir(join(tempDir, "kernel-venv"))).resolves.toBeUndefined();
	});

	it("frees the venv path while its interpreter is still running", async () => {
		const venv = createVenv();
		const interpreter = join(venv, binDir, executableName);
		const child = spawn(interpreter, ["-e", "setTimeout(() => {}, 30_000)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		try {
			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});

			await discardVenvDir(venv);

			// The path must be reusable for the new venv even though the old
			// interpreter still holds its image open.
			expect(existsSync(venv)).toBe(false);
		} finally {
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill();
			await exited;
		}
	});

	it("cleans up directories left behind by an earlier rebuild", async () => {
		const venv = createVenv();
		const leftover = `${venv}.stale-1234-5678`;
		mkdirSync(leftover, { recursive: true });
		writeFileSync(join(leftover, "python"), "");

		await discardVenvDir(venv);

		expect(existsSync(leftover)).toBe(false);
		expect(stagedDirs(venv)).toEqual([]);
	});
});
