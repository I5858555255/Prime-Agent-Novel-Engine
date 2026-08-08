#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "prime-agent-runtime", "kernel");
const supportedPlatforms = [
	{ target: "aarch64-apple-darwin", requireWheels: true },
	{ target: "x86_64-apple-darwin", requireWheels: true },
	{ target: "aarch64-unknown-linux-gnu", requireWheels: true },
	{ target: "x86_64-unknown-linux-gnu", requireWheels: true },
	{ target: "x86_64-pc-windows-msvc", requireWheels: true },
	{ target: "aarch64-linux-android", requireWheels: false },
];

function run(args) {
	const result = spawnSync("uv", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`uv ${args.join(" ")} failed with exit code ${result.status}`);
	}
}

run(["lock", "--project", project, "--python", "3.11", "--upgrade", "--exclude-newer", "7 days"]);

for (const platform of supportedPlatforms) {
	run([
		"sync",
		"--project",
		project,
		"--python",
		"3.11",
		"--python-platform",
		platform.target,
		"--locked",
		"--dry-run",
		"--no-dev",
		"--no-install-project",
		...(platform.requireWheels ? ["--no-build"] : []),
		"--exclude-newer",
		"7 days",
	]);
}

console.log(`validated ${supportedPlatforms.length} supported kernel platforms`);
