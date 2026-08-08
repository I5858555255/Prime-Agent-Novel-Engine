import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	ensureKernelPython,
	getKernelPythonPath,
	resolveKernelLockDigest,
	resolveKernelLockPlatform,
} from "../../../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((name) => `    "import ${name}") exit 0 ;;`);
	mkdirSync(binDir, { recursive: true });
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	process.env.UV_LOG = logPath;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			"set -e",
			'printf "%s|%s|%s\\n" "$UV_OFFLINE" "$VIRTUAL_ENV" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then exit 0; fi',
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			'    "import ipykernel") exit 0 ;;',
			...extraImportCases,
			'    *"_harness_methods"*) exit 0 ;;',
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "sync" ]; then',
			'  [ "$VIRTUAL_ENV" != "" ]',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			'  case "$*" in *ipykernel*|*pandas*|*scipy*) exit 71 ;; esac',
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

describe("issue #932 kernel runtime lock", () => {
	beforeEach(() => {
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-lock-"));
		process.env.HOME = tempDir;
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
	});

	afterEach(() => {
		process.env = originalEnv;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("maps every shipped platform to an explicit uv target", () => {
		expect(resolveKernelLockPlatform("darwin", "arm64")).toBe("aarch64-apple-darwin");
		expect(resolveKernelLockPlatform("darwin", "x64")).toBe("x86_64-apple-darwin");
		expect(resolveKernelLockPlatform("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
		expect(resolveKernelLockPlatform("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
		expect(resolveKernelLockPlatform("win32", "x64")).toBe("x86_64-pc-windows-msvc");
		expect(resolveKernelLockPlatform("android", "arm64")).toBe("aarch64-linux-android");
		expect(() => resolveKernelLockPlatform("linux", "s390x")).toThrow(/PRIME_AGENT_KERNEL_PYTHON/);
		expect(getKernelPythonPath("C:\\kernel", "win32")).toBe("C:\\kernel/Scripts/python.exe");
	});

	it("exact-syncs the reviewed lock, records its digest, and keeps skill resolution separate", async () => {
		const logPath = installFakeUv();
		process.env.UV_OFFLINE = "1";
		const venv = process.env.PRIME_AGENT_KERNEL_VENV as string;
		const skillDir = join(tempDir, "skills", "example");
		const pyprojectPath = join(skillDir, "pyproject.toml");
		mkdirSync(join(skillDir, "src", "example"), { recursive: true });
		writeFileSync(pyprojectPath, '[project]\nname = "example"\nversion = "0.1.0"\n');
		writeFileSync(join(skillDir, "src", "example", "__init__.py"), "");

		await expect(
			ensureKernelPython({
				pythonSkills: [{ name: "example", importName: "example", packagePath: skillDir, pyprojectPath }],
			}),
		).resolves.toBe(getKernelPythonPath(venv));

		const log = readFileSync(logPath, "utf8");
		const syncLine = log.split("\n").find((line) => line.includes("|sync --project"));
		expect(syncLine).toContain(`1|${venv}|`);
		expect(syncLine).toContain("--locked --active --no-dev --no-install-project --no-build");
		expect(syncLine).toContain(`--python-platform ${resolveKernelLockPlatform()}`);
		expect(syncLine).not.toContain(skillDir);
		expect(log).toContain(`pip install --python ${getKernelPythonPath(venv)} --no-deps`);
		expect(log).toContain(`pip install --python ${getKernelPythonPath(venv)} --editable ${skillDir}`);

		const marker = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		const lockPath = resolve(process.cwd(), "..", "..", "prime-agent-runtime", "kernel", "uv.lock");
		const expectedDigest = `sha256:${createHash("sha256").update(readFileSync(lockPath)).digest("hex")}`;
		expect(marker.kernelLock).toBe(expectedDigest);
		expect(await resolveKernelLockDigest()).toBe(expectedDigest);
	});

	it("rebuilds a warm environment when its recorded lock digest is stale", async () => {
		const logPath = installFakeUv();
		const venv = process.env.PRIME_AGENT_KERNEL_VENV as string;
		await ensureKernelPython();
		const markerPath = join(venv, ".bootstrap-version");
		const marker = JSON.parse(readFileSync(markerPath, "utf8"));
		writeFileSync(markerPath, `${JSON.stringify({ ...marker, kernelLock: "sha256:stale" })}\n`);

		await ensureKernelPython();

		const syncs = readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line.includes("|sync --project"));
		expect(syncs).toHaveLength(2);
		expect(JSON.parse(readFileSync(markerPath, "utf8")).kernelLock).toBe(await resolveKernelLockDigest());
	});
});
