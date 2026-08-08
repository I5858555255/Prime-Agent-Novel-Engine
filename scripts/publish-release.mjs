#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateReleaseRepository, validateRollbackRequest, verifyReleaseArtifacts } from "./lib/release-lifecycle.mjs";
import {
	promoteChannel,
	publishChannel,
	validatePromotion,
	verifyRemoteRelease,
} from "./lib/release-publication.mjs";

const sourceRoot = resolve(process.env.PRIME_AGENT_RELEASE_SOURCE_ROOT || process.cwd());

function parseArgs(args) {
	const operation = args[0];
	if (!["beta", "production", "rollback"].includes(operation)) {
		throw new Error("Usage: node scripts/publish-release.mjs <production|beta|rollback> [options]");
	}
	const options = { operation };
	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
		const value = args[index + 1];
		if (!value) throw new Error(`${argument} requires a value`);
		options[argument.slice(2).replaceAll(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
		index += 1;
	}
	return options;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: { ...process.env, AWS_PAGER: "" },
		maxBuffer: 10 * 1024 * 1024,
		stdio: "pipe",
	});
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(" ")} failed`);
	}
	return result.status === 0 ? result.stdout.trim() : undefined;
}

class AwsR2Store {
	constructor(bucket, endpoint) {
		if (!bucket || !endpoint) throw new Error("R2_BUCKET and R2_ENDPOINT_URL are required");
		this.bucket = bucket;
		this.endpoint = endpoint;
		this.temporaryDir = mkdtempSync(join(tmpdir(), "prime-agent-r2-"));
		this.temporaryIndex = 0;
	}

	dispose() {
		rmSync(this.temporaryDir, { force: true, recursive: true });
	}

	read(key) {
		const output = join(this.temporaryDir, `object-${this.temporaryIndex++}`);
		const result = spawnSync(
			"aws",
			[
				"s3api",
				"get-object",
				"--bucket",
				this.bucket,
				"--key",
				key,
				"--endpoint-url",
				this.endpoint,
				output,
			],
			{ encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }, stdio: "pipe" },
		);
		if (result.status !== 0) {
			const error = `${result.stderr}\n${result.stdout}`;
			if (/NoSuchKey|Not Found|404/i.test(error)) return undefined;
			throw new Error(error.trim() || `Unable to read R2 object ${key}`);
		}
		return readFileSync(output);
	}

	putImmutable(key, path, metadata) {
		const result = spawnSync(
			"aws",
			[
				"s3api",
				"put-object",
				"--bucket",
				this.bucket,
				"--key",
				key,
				"--body",
				path,
				"--if-none-match",
				"*",
				"--content-type",
				metadata.contentType,
				"--cache-control",
				metadata.cacheControl,
				"--endpoint-url",
				this.endpoint,
			],
			{ encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }, stdio: "pipe" },
		);
		if (result.status === 0) return true;
		const error = `${result.stderr}\n${result.stdout}`;
		if (/PreconditionFailed|412/i.test(error)) return false;
		throw new Error(error.trim() || `Unable to create immutable R2 object ${key}`);
	}

	putMutable(key, path, metadata) {
		run("aws", [
			"s3api",
			"put-object",
			"--bucket",
			this.bucket,
			"--key",
			key,
			"--body",
			path,
			"--content-type",
			metadata.contentType,
			"--cache-control",
			metadata.cacheControl,
			"--endpoint-url",
			this.endpoint,
		]);
	}
}

class GitHubReleaseMirror {
	constructor(repository) {
		if (!repository) throw new Error("GITHUB_REPOSITORY is required");
		this.repository = repository;
	}

	gh(args, options = {}) {
		return run("gh", [...args, "--repo", this.repository], options);
	}

	viewRelease(tag) {
		const output = this.gh(
			["release", "view", tag, "--json", "assets,isDraft,isPrerelease,targetCommitish"],
			{ allowFailure: true },
		);
		return output ? JSON.parse(output) : undefined;
	}

	readTagTarget(tag) {
		return run(
			"gh",
			["api", `repos/${this.repository}/git/ref/tags/${tag}`, "--jq", ".object.sha"],
			{ allowFailure: true },
		);
	}

	ensureTag(tag, buildRef) {
		const target = this.readTagTarget(tag);
		if (target && target !== buildRef) {
			throw new Error(`Immutable tag ${tag} points to ${target}, not ${buildRef}`);
		}
		if (!target) {
			run("gh", [
				"api",
				"--method",
				"POST",
				`repos/${this.repository}/git/refs`,
				"-f",
				`ref=refs/tags/${tag}`,
				"-f",
				`sha=${buildRef}`,
			]);
		}
	}

	ensureProductionRelease(tag, buildRef, notesFile) {
		this.ensureTag(tag, buildRef);
		const release = this.viewRelease(tag);
		if (!release) {
			this.gh([
				"release",
				"create",
				tag,
				"--verify-tag",
				"--target",
				buildRef,
				"--title",
				tag,
				"--notes-file",
				notesFile,
			]);
			return;
		}
		if (release.targetCommitish !== buildRef || release.isDraft || release.isPrerelease) {
			throw new Error(`Existing GitHub Release ${tag} does not match production commit ${buildRef}`);
		}
	}

	downloadAssets(tag, destination, assets) {
		if (assets.length === 0) return;
		this.gh(["release", "download", tag, "--dir", destination]);
	}

	verifyAssetDirectory(artifactsDir, downloadedDir, expectedNames) {
		const downloadedNames = readdirSync(downloadedDir).sort();
		if (JSON.stringify(downloadedNames) !== JSON.stringify(expectedNames)) {
			throw new Error(`GitHub Release assets are ${downloadedNames.join(", ")}; expected ${expectedNames.join(", ")}`);
		}
		for (const name of expectedNames) {
			if (!readFileSync(join(artifactsDir, name)).equals(readFileSync(join(downloadedDir, name)))) {
				throw new Error(`Existing GitHub Release asset differs: ${name}`);
			}
		}
	}

	ensureProductionAssets(tag, artifactsDir) {
		const expectedNames = readdirSync(artifactsDir).sort();
		let release = this.viewRelease(tag);
		if (!release) throw new Error(`GitHub Release ${tag} disappeared during publication`);
		const remoteNames = release.assets.map((asset) => asset.name).sort();
		for (const remoteName of remoteNames) {
			if (!expectedNames.includes(remoteName)) throw new Error(`Unexpected GitHub Release asset: ${remoteName}`);
		}
		const existingDir = mkdtempSync(join(tmpdir(), "prime-agent-gh-existing-"));
		try {
			this.downloadAssets(tag, existingDir, remoteNames);
			this.verifyAssetDirectory(artifactsDir, existingDir, remoteNames);
		} finally {
			rmSync(existingDir, { force: true, recursive: true });
		}
		for (const name of expectedNames) {
			if (!remoteNames.includes(name)) this.gh(["release", "upload", tag, join(artifactsDir, name)]);
		}

		release = this.viewRelease(tag);
		const finalNames = release?.assets.map((asset) => asset.name).sort() ?? [];
		const finalDir = mkdtempSync(join(tmpdir(), "prime-agent-gh-final-"));
		try {
			this.downloadAssets(tag, finalDir, finalNames);
			this.verifyAssetDirectory(artifactsDir, finalDir, expectedNames);
		} finally {
			rmSync(finalDir, { force: true, recursive: true });
		}
	}

	verifyExistingRelease(tag, artifactsDir) {
		const release = this.viewRelease(tag);
		if (!release || release.isDraft || release.isPrerelease) {
			throw new Error(`Stable GitHub Release ${tag} does not exist`);
		}
		const tagTarget = this.readTagTarget(tag);
		if (!tagTarget || release.targetCommitish !== tagTarget) {
			throw new Error(`Stable GitHub Release ${tag} does not match its immutable tag`);
		}
		const names = release.assets.map((asset) => asset.name).sort();
		this.downloadAssets(tag, artifactsDir, names);
		return tagTarget;
	}

	replaceBetaRelease(buildRef, version, artifactsDir, defaultBranch) {
		const betaTarget = this.readTagTarget("beta");
		if (betaTarget) {
			run("gh", [
				"api",
				"--method",
				"PATCH",
				`repos/${this.repository}/git/refs/tags/beta`,
				"-F",
				`sha=${buildRef}`,
				"-F",
				"force=true",
			]);
		} else {
			run("gh", [
				"api",
				"--method",
				"POST",
				`repos/${this.repository}/git/refs`,
				"-f",
				"ref=refs/tags/beta",
				"-f",
				`sha=${buildRef}`,
			]);
		}

		const notesDir = mkdtempSync(join(tmpdir(), "prime-agent-beta-notes-"));
		const notesFile = join(notesDir, "notes.md");
		try {
			writeFileSync(notesFile, `Automated beta build from \`${defaultBranch}\` (\`${buildRef}\`).\n`);
			const release = this.viewRelease("beta");
			if (release) {
				const assetIds = run(
					"gh",
					["api", `repos/${this.repository}/releases/tags/beta`, "--jq", ".assets[].id"],
				)
					.split("\n")
					.filter(Boolean);
				for (const assetId of assetIds) {
					run("gh", ["api", "--method", "DELETE", `repos/${this.repository}/releases/assets/${assetId}`]);
				}
				this.gh([
					"release",
					"edit",
					"beta",
					"--title",
					`Beta (v${version})`,
					"--target",
					buildRef,
					"--notes-file",
					notesFile,
					"--prerelease",
				]);
			} else {
				this.gh([
					"release",
					"create",
					"beta",
					"--title",
					`Beta (v${version})`,
					"--target",
					buildRef,
					"--notes-file",
					notesFile,
					"--prerelease",
				]);
			}
			for (const name of readdirSync(artifactsDir).sort()) {
				this.gh(["release", "upload", "beta", join(artifactsDir, name)]);
			}
		} finally {
			rmSync(notesDir, { force: true, recursive: true });
		}
	}

	latestDefaultBranchSha(defaultBranch) {
		return run("gh", ["api", `repos/${this.repository}/commits/${defaultBranch}`, "--jq", ".sha"]);
	}
}

function requireOption(options, name) {
	if (!options[name]) throw new Error(`--${name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
	return options[name];
}

function releaseFilesForRemoteVerification(artifactsDir) {
	return readdirSync(artifactsDir)
		.filter((file) => file === "SHA256SUMS" || file.endsWith(".tgz"))
		.sort();
}

function installers(options) {
	return [
		{ key: "install.sh", path: resolve(requireOption(options, "stableInstaller")) },
		{ key: "install-beta.sh", path: resolve(requireOption(options, "betaInstaller")) },
	];
}

function publishProduction(options, store, github, baseUrl) {
	const version = requireOption(options, "version");
	const buildRef = requireOption(options, "buildRef");
	const artifactsDir = resolve(requireOption(options, "artifactsDir"));
	validateReleaseRepository(sourceRoot, { requireChangelogs: true, version });
	verifyReleaseArtifacts(artifactsDir, { baseUrl, channel: "stable", version });
	validatePromotion(artifactsDir, "stable", store);
	const tag = `v${version}`;
	github.ensureProductionRelease(tag, buildRef, resolve(requireOption(options, "notesFile")));
	const result = publishChannel({
		artifactsDir,
		channel: "stable",
		installers: installers(options),
		mirror: () => github.ensureProductionAssets(tag, artifactsDir),
		store,
		version,
	});
	console.log(`Published production ${tag}: ${result.created} immutable objects created, ${result.reused} reused.`);
}

function publishBeta(options, store, github, baseUrl) {
	const version = requireOption(options, "version");
	const buildRef = requireOption(options, "buildRef");
	const defaultBranch = requireOption(options, "defaultBranch");
	const artifactsDir = resolve(requireOption(options, "artifactsDir"));
	if (github.latestDefaultBranchSha(defaultBranch) !== buildRef) {
		console.log("A newer default-branch commit exists; leaving beta release state unchanged.");
		return;
	}
	const requireCurrentBuild = () => {
		if (github.latestDefaultBranchSha(defaultBranch) !== buildRef) {
			throw new Error("A newer default-branch commit exists; refusing stale mutable beta updates");
		}
	};
	validateReleaseRepository(sourceRoot, { requireChangelogs: false, version: version.split("-", 1)[0] });
	verifyReleaseArtifacts(artifactsDir, { baseUrl, channel: "beta", version });
	const result = publishChannel({
		artifactsDir,
		beforeMutable: requireCurrentBuild,
		channel: "beta",
		installers: installers(options),
		mirror: () => github.replaceBetaRelease(buildRef, version, artifactsDir, defaultBranch),
		store,
		version,
	});
	console.log(`Published beta v${version}: ${result.created} immutable objects created, ${result.reused} reused.`);
}

function rollbackProduction(options, store, github, baseUrl) {
	const releaseTag = requireOption(options, "releaseTag");
	validateRollbackRequest(releaseTag, requireOption(options, "confirmation"));
	const artifactsDir = mkdtempSync(join(tmpdir(), "prime-agent-rollback-assets-"));
	try {
		const tagTarget = github.verifyExistingRelease(releaseTag, artifactsDir);
		const defaultBranch = requireOption(options, "defaultBranch");
		if (
			run("git", ["merge-base", "--is-ancestor", tagTarget, `origin/${defaultBranch}`], {
				allowFailure: true,
				cwd: sourceRoot,
			}) === undefined
		) {
			throw new Error(`Rollback tag ${releaseTag} is not on the default branch`);
		}
		const version = releaseTag.slice(1);
		verifyReleaseArtifacts(artifactsDir, { baseUrl, channel: "stable", version });
		verifyRemoteRelease(artifactsDir, version, store, {
			files: releaseFilesForRemoteVerification(artifactsDir),
		});
		promoteChannel(artifactsDir, "stable", store, { allowRegression: true });
		console.log(`Rolled back stable pointers to ${releaseTag}. Installed newer clients were not downgraded.`);
	} finally {
		rmSync(artifactsDir, { force: true, recursive: true });
	}
}

let store;
try {
	const options = parseArgs(process.argv.slice(2));
	const baseUrl = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
	if (!baseUrl) throw new Error("R2_PUBLIC_BASE_URL is required");
	store = new AwsR2Store(process.env.R2_BUCKET, process.env.R2_ENDPOINT_URL);
	const github = new GitHubReleaseMirror(process.env.GITHUB_REPOSITORY);
	if (options.operation === "production") publishProduction(options, store, github, baseUrl);
	else if (options.operation === "beta") publishBeta(options, store, github, baseUrl);
	else rollbackProduction(options, store, github, baseUrl);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	store?.dispose();
}
