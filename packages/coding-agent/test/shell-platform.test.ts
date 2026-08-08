import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getShellConfig, isBashUsable } from "../src/utils/shell.js";
import { removeTempDirSync } from "./utils/temp-fs.js";

describe("Windows shell resolution", () => {
	it("does not select the unusable WSL launcher from PATH", () => {
		if (process.platform !== "win32") return;

		const systemBash = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "bash.exe");
		if (!existsSync(systemBash) || isBashUsable(systemBash)) return;

		try {
			const config = getShellConfig();
			expect(config.shell.toLowerCase()).not.toBe(systemBash.toLowerCase());
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/No usable bash shell/i);
		}
	});

	it("rejects an existing but unusable custom shell", () => {
		if (process.platform !== "win32") return;

		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-shell-"));
		const shellPath = join(tempDir, "bash.exe");
		writeFileSync(shellPath, "not a Windows executable");

		try {
			expect(isBashUsable(shellPath)).toBe(false);
			expect(() => getShellConfig(shellPath)).toThrow(/cannot execute/i);
		} finally {
			removeTempDirSync(tempDir);
		}
	});
});
