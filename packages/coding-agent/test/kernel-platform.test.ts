import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getKernelVenvPythonPath, getUvInstallCommand } from "../src/core/kernel/bootstrap.js";

describe("kernel platform paths", () => {
	it("uses the Windows venv interpreter layout", () => {
		const venv = join("tmp", "kernel-venv");

		expect(getKernelVenvPythonPath(venv, "win32")).toBe(join(venv, "Scripts", "python.exe"));
		expect(getKernelVenvPythonPath(venv, "linux")).toBe(join(venv, "bin", "python"));
	});

	it("uses the native uv installer on Windows", () => {
		expect(getUvInstallCommand("win32")).toEqual({
			command: "powershell.exe",
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"],
		});
	});
});
