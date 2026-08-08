import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getKernelVenvPythonPath,
	getUvInstallCommand,
	windowsExecutableCandidates,
} from "../src/core/kernel/bootstrap.js";

describe("kernel platform paths", () => {
	it("uses the Windows venv interpreter layout", () => {
		const venv = join("tmp", "kernel-venv");

		expect(getKernelVenvPythonPath(venv, "win32")).toBe(join(venv, "Scripts", "python.exe"));
		expect(getKernelVenvPythonPath(venv, "linux")).toBe(join(venv, "bin", "python"));
	});

	it("looks for uv under every PATHEXT extension, not just .exe", () => {
		expect(windowsExecutableCandidates("uv", ".COM;.EXE;.BAT;.CMD")).toEqual([
			"uv",
			"uv.com",
			"uv.exe",
			"uv.bat",
			"uv.cmd",
		]);
	});

	it("falls back to the default PATHEXT set when the variable is unset", () => {
		expect(windowsExecutableCandidates("uv", undefined)).toContain("uv.cmd");
	});

	it("uses the native uv installer on Windows", () => {
		expect(getUvInstallCommand("win32")).toEqual({
			command: "powershell.exe",
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"],
		});
	});
});
