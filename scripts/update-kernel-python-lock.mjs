#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { constraints, project, root, toolchain } from "./kernel-lock-config.mjs";

function uv(args, capture = false) {
	const result = spawnSync("uv", args, {
		cwd: root,
		encoding: "utf8",
		stdio: capture ? "pipe" : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`uv ${args.join(" ")} failed with exit code ${result.status}`);
	}
	return result.stdout ?? "";
}

const version = uv(["--version"], true).trim();
if (!version.startsWith(`uv ${toolchain.uv} `) && version !== `uv ${toolchain.uv}`) {
	throw new Error(`refresh requires uv ${toolchain.uv}; found ${version || "no version"}`);
}

toolchain.excludeNewer = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
writeFileSync(join(project, "toolchain.json"), `${JSON.stringify(toolchain, null, "\t")}\n`, "utf8");

uv([
	"lock",
	"--project",
	project,
	"--python",
	toolchain.managedPython,
	"--upgrade",
	"--exclude-newer",
	toolchain.excludeNewer,
]);

const exported = uv(
	[
		"export",
		"--project",
		project,
		"--locked",
		"--no-dev",
		"--no-emit-project",
		"--no-header",
		"--no-hashes",
		"--python",
		toolchain.managedPython,
		"--exclude-newer",
		toolchain.excludeNewer,
	],
	true,
);
writeFileSync(constraints, exported, "utf8");

const check = spawnSync(process.execPath, ["scripts/check-kernel-python-lock.mjs"], {
	cwd: root,
	stdio: "inherit",
});
if (check.error) throw check.error;
if (check.status !== 0) process.exit(check.status ?? 1);
