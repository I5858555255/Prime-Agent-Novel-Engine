import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quoteWindowsShellArg, signalProcessGroupOrProcess } from "../src/utils/child-process.js";
import { removeTempDirSync } from "./utils/temp-fs.js";

describe("quoteWindowsShellArg", () => {
	it("leaves ordinary arguments untouched", () => {
		expect(quoteWindowsShellArg("venv")).toBe("venv");
		expect(quoteWindowsShellArg(String.raw`C:\Users\ada\.prime`)).toBe(String.raw`C:\Users\ada\.prime`);
	});

	it("quotes paths containing spaces so cmd.exe keeps them as one argument", () => {
		expect(quoteWindowsShellArg(String.raw`C:\Users\Ada Lovelace\venv`)).toBe(
			String.raw`"C:\Users\Ada Lovelace\venv"`,
		);
	});

	it("quotes shell metacharacters and escapes embedded quotes", () => {
		expect(quoteWindowsShellArg("a&b")).toBe('"a&b"');
		expect(quoteWindowsShellArg('say "hi"')).toBe(String.raw`"say \"hi\""`);
	});

	it("doubles trailing backslashes so they cannot escape the closing quote", () => {
		// A raw template cannot end in a lone backslash, so these stay escaped.
		expect(quoteWindowsShellArg("C:Program Files\\")).toBe('"C:Program Files\\\\"');
	});
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

describe.skipIf(process.platform !== "win32")("Windows process-tree signaling", () => {
	let tempDir: string | undefined;
	let rootPid: number | undefined;
	let grandchildPid: number | undefined;

	afterEach(() => {
		if (rootPid && isAlive(rootPid)) {
			try {
				execFileSync("taskkill", ["/F", "/T", "/PID", String(rootPid)], { stdio: "ignore", windowsHide: true });
			} catch {
				// The process may already have exited.
			}
		}
		if (grandchildPid && isAlive(grandchildPid)) {
			try {
				execFileSync("taskkill", ["/F", "/T", "/PID", String(grandchildPid)], {
					stdio: "ignore",
					windowsHide: true,
				});
			} catch {
				// The process may already have exited.
			}
		}
		if (tempDir) removeTempDirSync(tempDir);
	});

	it("terminates a detached descendant tree", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-process-tree-"));
		const pidFile = join(tempDir, "grandchild.pid");
		const script = [
			"const fs = require('node:fs');",
			"const { spawn } = require('node:child_process');",
			"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
			"fs.writeFileSync(process.argv[1], String(child.pid));",
			"child.unref();",
			"setInterval(() => {}, 60000);",
		].join(" ");
		const root = spawn(process.execPath, ["-e", script, pidFile], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		rootPid = root.pid;
		if (!rootPid) throw new Error("Missing root process id");
		await waitForFile(pidFile);
		grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		expect(isAlive(grandchildPid)).toBe(true);

		signalProcessGroupOrProcess(rootPid, "SIGKILL");
		const deadline = Date.now() + 3000;
		while ((isAlive(rootPid) || isAlive(grandchildPid)) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(isAlive(rootPid)).toBe(false);
		expect(isAlive(grandchildPid)).toBe(false);
	});
});
