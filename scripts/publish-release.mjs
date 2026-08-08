#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
	validateAuthorizedRollbackTarget,
	validateReleaseRepository,
	validateRollbackRequest,
	verifyReleaseArtifacts,
} from "./lib/release-lifecycle.mjs";
import {
	promoteChannel,
	publishImmutableArtifacts,
	publishInstallers,
	validatePromotion,
	verifyRemoteRelease,
} from "./lib/release-publication.mjs";
import {
	isGitHubNotFoundError,
	isR2MissingObjectError,
	isR2PreconditionFailure,
	readPublicGitHubBranchSha,
	runCommand,
} from "./lib/release-command.mjs";

const sourceRoot = resolve(process.env.PRIME_AGENT_RELEASE_SOURCE_ROOT || process.cwd());

function parseArgs(args) {
	const operation = args[0];
	const operations = new Set([
		"beta-github",
		"beta-r2-installers",
		"beta-r2-immutable",
		"beta-r2-promote",
		"production-github-assets",
		"production-github-prepare",
		"production-r2-installers",
		"production-r2-immutable",
		"production-r2-promote",
		"rollback-github-verify",
		"rollback-r2-promote",
	]);
	if (!operations.has(operation)) {
		throw new Error(`Unsupported release publication phase: ${operation ?? "missing"}`);
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
		const result = runCommand(
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
			{ acceptFailure: isR2MissingObjectError },
		);
		if (result === undefined) return undefined;
		return readFileSync(output);
	}

	putImmutable(key, path, metadata) {
		const result = runCommand(
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
			{ acceptFailure: isR2PreconditionFailure },
		);
		return result !== undefined;
	}

	putMutable(key, path, metadata) {
		runCommand("aws", [
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
		return runCommand("gh", [...args, "--repo", this.repository], options);
	}

	api(args, options = {}) {
		return runCommand("gh", ["api", ...args], options);
	}

	viewRelease(tag) {
		const output = this.api(
			[
				`repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`,
				"--jq",
				"{assets: .assets, isDraft: .draft, isPrerelease: .prerelease, targetCommitish: .target_commitish}",
			],
			{ acceptFailure: isGitHubNotFoundError },
		);
		return output ? JSON.parse(output) : undefined;
	}

	readTagTarget(tag) {
		const output = this.api(
			[
				`repos/${this.repository}/git/ref/tags/${encodeURIComponent(tag)}`,
				"--jq",
				"{sha: .object.sha, type: .object.type}",
			],
			{ acceptFailure: isGitHubNotFoundError },
		);
		if (!output) return undefined;
		let target = JSON.parse(output);
		for (let depth = 0; target.type === "tag" && depth < 8; depth += 1) {
			target = JSON.parse(
				this.api([
					`repos/${this.repository}/git/tags/${target.sha}`,
					"--jq",
					"{sha: .object.sha, type: .object.type}",
				]),
			);
		}
		if (target.type !== "commit" || !/^[0-9a-f]{40}$/.test(target.sha)) {
			throw new Error(`Tag ${tag} does not resolve to a commit`);
		}
		return target.sha;
	}

	ensureTag(tag, buildRef) {
		const target = this.readTagTarget(tag);
		if (target && target !== buildRef) {
			throw new Error(`Immutable tag ${tag} points to ${target}, not ${buildRef}`);
		}
		if (!target) {
			runCommand("gh", [
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

	verifyExistingRelease(tag, artifactsDir, expectedTarget) {
		const release = this.viewRelease(tag);
		if (!release || release.isDraft || release.isPrerelease) {
			throw new Error(`Stable GitHub Release ${tag} does not exist`);
		}
		const tagTarget = this.readTagTarget(tag);
		if (!tagTarget || release.targetCommitish !== tagTarget) {
			throw new Error(`Stable GitHub Release ${tag} does not match its immutable tag`);
		}
		validateAuthorizedRollbackTarget(tag, expectedTarget, tagTarget);
		const names = release.assets.map((asset) => asset.name).sort();
		this.downloadAssets(tag, artifactsDir, names);
		return tagTarget;
	}

	replaceBetaRelease(buildRef, version, artifactsDir, defaultBranch) {
		const betaTarget = this.readTagTarget("beta");
		if (betaTarget) {
			runCommand("gh", [
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
			runCommand("gh", [
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
				const assetIds = runCommand(
					"gh",
					["api", `repos/${this.repository}/releases/tags/beta`, "--jq", ".assets[].id"],
				)
					.split("\n")
					.filter(Boolean);
				for (const assetId of assetIds) {
					runCommand("gh", ["api", "--method", "DELETE", `repos/${this.repository}/releases/assets/${assetId}`]);
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
			const finalRelease = this.viewRelease("beta");
			if (!finalRelease || finalRelease.isDraft || !finalRelease.isPrerelease || finalRelease.targetCommitish !== buildRef) {
				throw new Error(`Beta GitHub Release does not match commit ${buildRef}`);
			}
			const expectedNames = readdirSync(artifactsDir).sort();
			const finalNames = finalRelease.assets.map((asset) => asset.name).sort();
			const finalDir = mkdtempSync(join(tmpdir(), "prime-agent-beta-final-"));
			try {
				this.downloadAssets("beta", finalDir, finalNames);
				this.verifyAssetDirectory(artifactsDir, finalDir, expectedNames);
			} finally {
				rmSync(finalDir, { force: true, recursive: true });
			}
		} finally {
			rmSync(notesDir, { force: true, recursive: true });
		}
	}

	latestDefaultBranchSha(defaultBranch) {
		return this.api([`repos/${this.repository}/commits/${encodeURIComponent(defaultBranch)}`, "--jq", ".sha"]);
	}
}

function requireOption(options, name) {
	if (!options[name]) throw new Error(`--${name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
	return options[name];
}

function installers(options) {
	return [
		{ key: "install.sh", path: resolve(requireOption(options, "stableInstaller")) },
		{ key: "install-beta.sh", path: resolve(requireOption(options, "betaInstaller")) },
	];
}

function assertLatestDefaultBranch(options, buildRef) {
	const repository = process.env.GITHUB_REPOSITORY;
	if (!repository) throw new Error("GITHUB_REPOSITORY is required for beta mutation");
	const defaultBranch = requireOption(options, "defaultBranch");
	const latestSha = readPublicGitHubBranchSha(repository, defaultBranch);
	if (latestSha !== buildRef) {
		throw new Error(`A newer default-branch commit exists; refusing stale beta update (${latestSha})`);
	}
}

function validatePhaseArtifacts(options, baseUrl, channel) {
	const version = requireOption(options, "version");
	const buildRef = requireOption(options, "buildRef");
	const sourceSha = requireOption(options, "sourceSha");
	if (!/^[0-9a-f]{40}$/.test(buildRef) || sourceSha !== buildRef) {
		throw new Error(`Release build ref and source SHA must be the same full commit SHA: ${buildRef}/${sourceSha}`);
	}
	const artifactsDir = resolve(requireOption(options, "artifactsDir"));
	validateReleaseRepository(sourceRoot, {
		requireChangelogs: channel === "stable",
		version: channel === "beta" ? version.split("-", 1)[0] : version,
	});
	verifyReleaseArtifacts(artifactsDir, { baseUrl, channel, sourceSha, version });
	return { artifactsDir, buildRef, sourceSha, version };
}

function prepareProductionGitHub(options, github, baseUrl) {
	const { buildRef, version } = validatePhaseArtifacts(options, baseUrl, "stable");
	github.ensureProductionRelease(`v${version}`, buildRef, resolve(requireOption(options, "notesFile")));
}

function publishProductionR2Immutable(options, store, baseUrl) {
	const { artifactsDir, version } = validatePhaseArtifacts(options, baseUrl, "stable");
	validatePromotion(artifactsDir, "stable", store);
	const result = publishImmutableArtifacts(artifactsDir, version, store);
	verifyRemoteRelease(artifactsDir, version, store);
	console.log(`Published production immutable objects: ${result.created} created, ${result.reused} reused.`);
}

function publishProductionGitHubAssets(options, github, baseUrl) {
	const { artifactsDir, buildRef, version } = validatePhaseArtifacts(options, baseUrl, "stable");
	const tag = `v${version}`;
	github.ensureProductionRelease(tag, buildRef, resolve(requireOption(options, "notesFile")));
	github.ensureProductionAssets(tag, artifactsDir);
}

function promoteProductionR2(options, store, baseUrl) {
	const { artifactsDir, version } = validatePhaseArtifacts(options, baseUrl, "stable");
	validatePromotion(artifactsDir, "stable", store);
	verifyRemoteRelease(artifactsDir, version, store);
	promoteChannel(artifactsDir, "stable", store);
	console.log(`Promoted production v${version}.`);
}

function publishBetaR2Immutable(options, store, baseUrl) {
	const { artifactsDir, version } = validatePhaseArtifacts(options, baseUrl, "beta");
	const result = publishImmutableArtifacts(artifactsDir, version, store);
	verifyRemoteRelease(artifactsDir, version, store);
	console.log(`Published beta immutable objects: ${result.created} created, ${result.reused} reused.`);
}

function publishBetaGitHub(options, github, baseUrl) {
	const { artifactsDir, buildRef, version } = validatePhaseArtifacts(options, baseUrl, "beta");
	const defaultBranch = requireOption(options, "defaultBranch");
	if (github.latestDefaultBranchSha(defaultBranch) !== buildRef) {
		throw new Error("A newer default-branch commit exists; refusing stale GitHub beta update");
	}
	github.replaceBetaRelease(buildRef, version, artifactsDir, defaultBranch);
}

function publishR2Installers(options, store, baseUrl, channel) {
	const { artifactsDir, buildRef, version } = validatePhaseArtifacts(options, baseUrl, channel);
	verifyRemoteRelease(artifactsDir, version, store);
	publishInstallers(installers(options), store, {
		beforeWrite: channel === "beta" ? () => assertLatestDefaultBranch(options, buildRef) : undefined,
	});
	console.log(`Published ${channel} installers for v${version}.`);
}

function promoteBetaR2(options, store, baseUrl) {
	const { artifactsDir, buildRef, version } = validatePhaseArtifacts(options, baseUrl, "beta");
	verifyRemoteRelease(artifactsDir, version, store);
	promoteChannel(artifactsDir, "beta", store, {
		beforeWrite: () => assertLatestDefaultBranch(options, buildRef),
	});
	console.log(`Promoted beta v${version}.`);
}

function verifyRollbackGitHub(options, github, baseUrl) {
	const releaseTag = requireOption(options, "releaseTag");
	validateRollbackRequest(releaseTag, requireOption(options, "confirmation"));
	const sourceSha = requireOption(options, "sourceSha");
	if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("Rollback source SHA must be a full commit SHA");
	const artifactsDir = resolve(requireOption(options, "artifactsDir"));
	mkdirSync(artifactsDir, { recursive: true });
	if (readdirSync(artifactsDir).length > 0) {
		throw new Error(`Rollback artifact directory must be empty: ${artifactsDir}`);
	}
	const tagTarget = github.verifyExistingRelease(releaseTag, artifactsDir, sourceSha);
	const defaultBranch = requireOption(options, "defaultBranch");
	if (
		runCommand("git", ["merge-base", "--is-ancestor", tagTarget, `origin/${defaultBranch}`], {
			allowFailure: true,
			cwd: sourceRoot,
		}) === undefined
	) {
		throw new Error(`Rollback tag ${releaseTag} is not on the default branch`);
	}
	verifyReleaseArtifacts(artifactsDir, {
		allowMissingProvenance: true,
		baseUrl,
		channel: "stable",
		sourceSha: tagTarget,
		version: releaseTag.slice(1),
	});
	console.log(`Verified rollback release ${releaseTag} at ${tagTarget}.`);
}

function promoteRollbackR2(options, store, baseUrl) {
	const releaseTag = requireOption(options, "releaseTag");
	validateRollbackRequest(releaseTag, requireOption(options, "confirmation"));
	const artifactsDir = resolve(requireOption(options, "artifactsDir"));
	const sourceSha = requireOption(options, "sourceSha");
	const version = releaseTag.slice(1);
	verifyReleaseArtifacts(artifactsDir, {
		allowMissingProvenance: true,
		baseUrl,
		channel: "stable",
		sourceSha,
		version,
	});
	verifyRemoteRelease(artifactsDir, version, store);
	promoteChannel(artifactsDir, "stable", store, { allowRegression: true });
	console.log(`Rolled back stable pointers to ${releaseTag}. Installed newer clients were not downgraded.`);
}

let store;
try {
	const options = parseArgs(process.argv.slice(2));
	const baseUrl = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
	if (!baseUrl) throw new Error("R2_PUBLIC_BASE_URL is required");
	if (options.operation.includes("-r2-")) {
		store = new AwsR2Store(process.env.R2_BUCKET, process.env.R2_ENDPOINT_URL);
	}
	const github = options.operation.includes("github")
		? new GitHubReleaseMirror(process.env.GITHUB_REPOSITORY)
		: undefined;
	if (options.operation === "production-github-prepare") prepareProductionGitHub(options, github, baseUrl);
	else if (options.operation === "production-r2-immutable") publishProductionR2Immutable(options, store, baseUrl);
	else if (options.operation === "production-github-assets") publishProductionGitHubAssets(options, github, baseUrl);
	else if (options.operation === "production-r2-installers") publishR2Installers(options, store, baseUrl, "stable");
	else if (options.operation === "production-r2-promote") promoteProductionR2(options, store, baseUrl);
	else if (options.operation === "beta-r2-immutable") publishBetaR2Immutable(options, store, baseUrl);
	else if (options.operation === "beta-github") publishBetaGitHub(options, github, baseUrl);
	else if (options.operation === "beta-r2-installers") publishR2Installers(options, store, baseUrl, "beta");
	else if (options.operation === "beta-r2-promote") promoteBetaR2(options, store, baseUrl);
	else if (options.operation === "rollback-github-verify") verifyRollbackGitHub(options, github, baseUrl);
	else promoteRollbackR2(options, store, baseUrl);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	store?.dispose();
}
