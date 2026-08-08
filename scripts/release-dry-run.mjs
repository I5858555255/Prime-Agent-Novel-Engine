#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateReleaseRepository, verifyReleaseArtifacts } from "./lib/release-lifecycle.mjs";

const toolingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.PRIME_AGENT_RELEASE_SOURCE_ROOT || toolingRoot);
const defaultBaseUrl = "https://release.invalid";

function parseArgs(args) {
	const parsed = {
		artifactsDir: undefined,
		baseUrl: defaultBaseUrl,
		channel: "stable",
		sourceSha: process.env.PRIME_AGENT_SOURCE_SHA,
		version: undefined,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			console.log(
				"Usage: npm run release:dry-run -- [--channel stable|beta] [--version version] [--source-sha sha] [--base-url url] [--artifacts-dir path]",
			);
			process.exit(0);
		}
		if (!["--artifacts-dir", "--base-url", "--channel", "--source-sha", "--version"].includes(argument)) {
			throw new Error(`Unknown argument: ${argument}`);
		}
		const key = {
			"--artifacts-dir": "artifactsDir",
			"--base-url": "baseUrl",
			"--channel": "channel",
			"--source-sha": "sourceSha",
			"--version": "version",
		}[argument];
		const value = args[index + 1];
		if (!value) throw new Error(`${argument} requires a value`);
		parsed[key] = value;
		index += 1;
	}
	if (parsed.channel !== "stable" && parsed.channel !== "beta") {
		throw new Error("--channel must be stable or beta");
	}
	if (!parsed.sourceSha) {
		const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: "pipe" });
		if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to resolve release source SHA");
		parsed.sourceSha = result.stdout.trim();
	}
	if (!/^[0-9a-f]{40}$/.test(parsed.sourceSha)) {
		throw new Error(`--source-sha must be a full 40-character commit SHA: ${parsed.sourceSha}`);
	}
	return parsed;
}

function runPacker(options, outDir) {
	const result = spawnSync(
		process.execPath,
		[
			join(toolingRoot, "scripts/pack-prime-agent-release.mjs"),
			"--channel",
			options.channel,
			"--version",
			options.version,
			"--base-url",
			options.baseUrl,
			"--source-sha",
			options.sourceSha,
			"--out-dir",
			outDir,
		],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, PRIME_AGENT_RELEASE_SOURCE_ROOT: root },
			stdio: "pipe",
		},
	);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || "Release packer failed");
	}
	if (result.stdout) process.stdout.write(result.stdout);
}

try {
	const options = parseArgs(process.argv.slice(2));
	const repository = validateReleaseRepository(root, {
		requireChangelogs: true,
		version: options.channel === "beta" && options.version ? options.version.split("-", 1)[0] : options.version,
	});
	options.version ??= repository.version;
	const temporaryOutDir = join(
		root,
		"packages/coding-agent/release",
		`dry-run-${process.pid}-${Date.now().toString(36)}`,
	);
	const suppliedArtifactsDir = options.artifactsDir
		? resolve(root, options.artifactsDir)
		: undefined;
	const artifactsDir = suppliedArtifactsDir ?? join(temporaryOutDir, "artifacts");
	try {
		if (!suppliedArtifactsDir) runPacker(options, temporaryOutDir);
		if (!existsSync(artifactsDir)) throw new Error(`Artifact directory does not exist: ${artifactsDir}`);
		const manifest = verifyReleaseArtifacts(artifactsDir, options);
		console.log(`Validated ${manifest.version} ${options.channel} artifacts without publishing.`);
	} finally {
		if (!suppliedArtifactsDir) rmSync(temporaryOutDir, { force: true, recursive: true });
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
