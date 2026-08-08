import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getVenvPythonPath } from "../src/core/kernel/bootstrap.js";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
	setPlatform(realPlatform);
});

describe("getVenvPythonPath", () => {
	it("uses the POSIX venv layout off Windows", () => {
		setPlatform("linux");
		expect(getVenvPythonPath("/home/u/.prime/agent/kernel-venv")).toBe(
			join("/home/u/.prime/agent/kernel-venv", "bin", "python"),
		);
	});

	it("uses the Windows venv layout on win32", () => {
		setPlatform("win32");
		// uv/virtualenv place the interpreter in Scripts\python.exe on Windows;
		// the POSIX path never exists there, so every readiness probe would fail
		// and the venv would be torn down and rebuilt on every launch.
		expect(getVenvPythonPath("C:\\Users\\u\\.prime\\agent\\kernel-venv")).toBe(
			join("C:\\Users\\u\\.prime\\agent\\kernel-venv", "Scripts", "python.exe"),
		);
	});
});
