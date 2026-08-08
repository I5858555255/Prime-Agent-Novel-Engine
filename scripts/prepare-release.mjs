#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareRelease } from "./lib/release-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readArgs(args) {
	let date;
	let target;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--date") {
			date = args[index + 1];
			if (!date) throw new Error("--date requires YYYY-MM-DD");
			index += 1;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			console.log("Usage: npm run release:prepare -- <patch|minor|0.x.y> [--date YYYY-MM-DD]");
			process.exit(0);
		}
		if (target) throw new Error(`Unexpected argument: ${argument}`);
		target = argument;
	}
	if (!target) throw new Error("Release target is required: patch, minor, or an explicit 0.x.y version");
	return { date, target };
}

function requireCleanWorktree() {
	const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || "Unable to inspect the Git worktree");
	}
	if (result.stdout.trim()) {
		throw new Error("Release preparation requires a clean worktree; commit or discard unrelated changes first");
	}
}

try {
	const { date, target } = readArgs(process.argv.slice(2));
	requireCleanWorktree();
	const changed = prepareRelease(root, target, { date });
	console.log("Prepared release metadata without staging, committing, tagging, pushing, or publishing:");
	for (const path of changed) console.log(`- ${path}`);
	console.log("Review the diff, run `npm run release:dry-run`, and open a release-preparation pull request.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
