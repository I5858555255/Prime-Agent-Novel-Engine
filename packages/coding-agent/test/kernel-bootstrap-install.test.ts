import { describe, expect, it } from "vitest";
import { createUvInstallLaunchSpec } from "../src/core/kernel/bootstrap.js";

describe("uv bootstrap installer", () => {
	it("uses the native PowerShell installer on Windows", () => {
		expect(createUvInstallLaunchSpec("win32", { SystemRoot: String.raw`D:\Windows` })).toEqual({
			command: String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
			args: [
				"-NoLogo",
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				"irm https://astral.sh/uv/install.ps1 | iex",
			],
			displayCommand: "irm https://astral.sh/uv/install.ps1 | iex",
		});
	});
});
