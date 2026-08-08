#!/usr/bin/env node

// End-to-end guard for the Windows kernel path, run from .github/workflows/windows.yml.
//
// Asserts three things the Linux jobs cannot:
//   1. ensureKernelPython resolves to <venv>\Scripts\python.exe and that file exists.
//   2. A second ensureKernelPython call is a cache hit rather than a full rebuild.
//      (The venv used to be torn down and rebuilt on every launch because the
//      readiness probe looked for a POSIX interpreter path that never exists.)
//   3. A kernel actually starts over ZMQ and runs a cell.

import { existsSync } from "node:fs";
import { join } from "node:path";

const REBUILD_BUDGET_MS = 30_000;

const { ensureKernelPython, getKernelVenvDir, getVenvPythonPath } = await import(
	"../dist/core/kernel/bootstrap.js"
);
const { KernelManager } = await import("../dist/core/kernel/index.js");

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

const venv = getKernelVenvDir();
const expectedPython = join(venv, "Scripts", "python.exe");

if (getVenvPythonPath(venv) !== expectedPython) {
	fail(`getVenvPythonPath returned ${getVenvPythonPath(venv)}, expected ${expectedPython}`);
}

console.log("bootstrapping kernel venv (cold)...");
const coldStarted = Date.now();
const python = await ensureKernelPython({ onProgress: (message) => console.log(`  ${message}`) });
console.log(`cold bootstrap finished in ${Math.round((Date.now() - coldStarted) / 1000)}s -> ${python}`);

if (python !== expectedPython) {
	fail(`ensureKernelPython returned ${python}, expected ${expectedPython}`);
}
if (!existsSync(python)) {
	fail(`${python} does not exist`);
}

console.log("bootstrapping again (should be a cache hit)...");
const warmStarted = Date.now();
await ensureKernelPython();
const warmMs = Date.now() - warmStarted;
console.log(`warm bootstrap finished in ${warmMs}ms`);

if (warmMs > REBUILD_BUDGET_MS) {
	fail(`second bootstrap took ${warmMs}ms; the venv is being rebuilt instead of reused`);
}

console.log("starting kernel...");
const kernel = new KernelManager({ cwd: process.cwd() });
try {
	await kernel.start();
	const result = await kernel.execute("import platform; print(platform.system())");
	console.log(`kernel stdout: ${JSON.stringify(result.stdout)}`);
	if (result.status !== "ok") {
		fail(`kernel execution status was ${result.status}: ${result.stderr}`);
	}
	if (!result.stdout.includes("Windows")) {
		fail(`kernel did not report a Windows interpreter: ${result.stdout}`);
	}
} finally {
	await kernel.shutdown().catch(() => undefined);
}

console.log("OK: Windows kernel path is healthy");
