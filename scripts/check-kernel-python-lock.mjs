#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { constraints, project, root, supportedPlatforms, toolchain } from "./kernel-lock-config.mjs";

function uv(args, capture = false) {
	const result = spawnSync("uv", args, {
		cwd: root,
		encoding: "utf8",
		stdio: capture ? "pipe" : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`uv ${args.join(" ")} failed with exit code ${result.status}`);
	return result.stdout ?? "";
}

function projectDependencies(file) {
	const source = readFileSync(file, "utf8");
	const project = source.match(/\[project\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
	const dependencies = project.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
	return [...dependencies.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((match) =>
		match[1].replaceAll("_", "-").toLowerCase(),
	);
}

const version = uv(["--version"], true).trim();
if (!version.startsWith(`uv ${toolchain.uv} `) && version !== `uv ${toolchain.uv}`) {
	throw new Error(`lock validation requires uv ${toolchain.uv}; found ${version || "no version"}`);
}

uv([
	"lock",
	"--project",
	project,
	"--python",
	toolchain.managedPython,
	"--exclude-newer",
	toolchain.excludeNewer,
	"--check",
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
const constraintsSource = readFileSync(constraints, "utf8");
if (constraintsSource !== exported) {
	throw new Error("kernel constraints.txt does not match uv.lock; run npm run refresh-python-lock");
}
const constraintLines = constraintsSource.split("\n");
for (const nativePackage of toolchain.termuxPython.nativePackages) {
	const expected = `${nativePackage.distribution}==${nativePackage.version}`;
	if (!constraintLines.some((line) => line === expected || line.startsWith(`${expected} `))) {
		throw new Error(`Termux native package ${expected} does not match the kernel lock`);
	}
}

for (const platform of supportedPlatforms) {
	uv([
		"sync",
		"--project",
		project,
		"--python",
		platform.python,
		"--python-platform",
		platform.target,
		"--locked",
		"--dry-run",
		"--no-dev",
		"--no-install-project",
		"--exclude-newer",
		toolchain.excludeNewer,
		...(platform.requireWheels ? ["--no-build"] : []),
	]);
}

const kernelDependencies = new Set(projectDependencies(join(project, "pyproject.toml")));
const runtimeDependencies = projectDependencies(join(root, "prime-agent-runtime", "pyproject.toml"));
const missing = runtimeDependencies.filter((dependency) => !kernelDependencies.has(dependency));
if (missing.length > 0) {
	throw new Error(`kernel project is missing runtime dependencies: ${missing.join(", ")}`);
}
if (!kernelDependencies.has("hatchling")) {
	throw new Error("kernel project must install the pinned runtime build backend");
}

console.log(`validated kernel lock for ${supportedPlatforms.length} desktop targets`);
