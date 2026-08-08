#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitShaPattern = /^[0-9a-f]{40}$/;
const productionVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const packageManifests = {
	root: "package.json",
	agent: "packages/agent/package.json",
	ai: "packages/ai/package.json",
	"coding-agent": "packages/coding-agent/package.json",
	tui: "packages/tui/package.json",
};

function assertCommitSha(value, name) {
	if (!commitShaPattern.test(value)) {
		throw new Error(`${name} must be a full 40-character commit SHA: ${value}`);
	}
}

function normalizeProductionVersion(value) {
	const normalized = value.startsWith("v") ? value.slice(1) : value;
	if (!productionVersionPattern.test(normalized)) {
		throw new Error(`Production version must be plain semver like 0.0.1: ${value}`);
	}
	return normalized;
}

function assertPositiveInteger(value, name) {
	if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer: ${value}`);
}

export function assertLockstepVersions(packageVersions) {
	const entries = Object.entries(packageVersions);
	if (entries.length === 0) throw new Error("At least one package version is required");
	const expected = entries[0][1];
	const mismatches = entries.filter(([, version]) => version !== expected);
	if (mismatches.length > 0) {
		throw new Error(
			`Release package versions must match ${expected}: ${mismatches
				.map(([name, version]) => `${name}=${version}`)
				.join(", ")}`,
		);
	}
	return normalizeProductionVersion(expected);
}

function requireTrustedWorkflowRun(options) {
	const run = options.workflowRun;
	if (!run) throw new Error("workflow_run metadata is required");
	if (run.conclusion !== "success") {
		throw new Error(`CI conclusion must be success, received ${run.conclusion || "missing"}`);
	}
	if (run.event !== "push") throw new Error(`CI event must be push, received ${run.event || "missing"}`);
	if (run.headBranch !== options.defaultBranch) {
		throw new Error(`CI branch must be ${options.defaultBranch}, received ${run.headBranch || "missing"}`);
	}
	if (run.headRepository !== options.repository) {
		throw new Error(`CI repository must be ${options.repository}, received ${run.headRepository || "missing"}`);
	}
	if (run.workflowPath !== ".github/workflows/ci.yml") {
		throw new Error(`CI workflow path is not trusted: ${run.workflowPath || "missing"}`);
	}
	if (run.headSha !== options.buildSha) {
		throw new Error(`CI verified ${run.headSha || "missing"}, not ${options.buildSha}`);
	}
}

export function resolveReleaseContext(options) {
	assertCommitSha(options.buildSha, "Build SHA");
	const productionVersion = assertLockstepVersions(options.packageVersions);
	let betaVersion = "";
	let publishBeta = false;
	let publishProduction = false;
	let trigger;

	if (options.eventName === "workflow_run") {
		requireTrustedWorkflowRun(options);
		assertPositiveInteger(options.runNumber, "Run number");
		assertPositiveInteger(options.runAttempt, "Run attempt");
		trigger = "main";
		publishBeta = true;
		betaVersion = `${productionVersion}-beta.${options.runNumber}.${options.runAttempt}.${options.buildSha.slice(0, 7)}`;
		publishProduction = options.existingTagSha === null || options.existingTagSha === options.buildSha;
	} else if (options.eventName === "workflow_dispatch") {
		if (options.refName !== options.defaultBranch) {
			throw new Error(
				`Manual releases must run from the default branch (${options.defaultBranch}), not ${options.refName}`,
			);
		}
		const requestedVersion = normalizeProductionVersion(options.inputReleaseTag || "");
		if (requestedVersion !== productionVersion) {
			throw new Error(`Manual release v${requestedVersion} does not match package version ${productionVersion}`);
		}
		trigger = "manual";
		publishProduction = true;
	} else if (options.eventName === "push" && options.refType === "tag") {
		const taggedVersion = normalizeProductionVersion(options.refName || "");
		if (taggedVersion !== productionVersion) {
			throw new Error(`Tag v${taggedVersion} does not match package version ${productionVersion}`);
		}
		trigger = "tag";
		publishProduction = true;
	} else {
		throw new Error(`Unsupported release trigger: ${options.eventName}/${options.refType || "none"}`);
	}

	if (publishProduction && options.existingTagSha && options.existingTagSha !== options.buildSha) {
		throw new Error(
			`Production v${productionVersion} points to ${options.existingTagSha}, not ${options.buildSha}`,
		);
	}

	return {
		betaVersion,
		buildSha: options.buildSha,
		productionVersion,
		publishBeta,
		publishProduction,
		trigger,
	};
}

function runGit(args, allowFailure = false) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
	if (result.status !== 0) {
		if (allowFailure) return null;
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function readPackageVersions() {
	return Object.fromEntries(
		Object.entries(packageManifests).map(([name, path]) => {
			const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8"));
			return [name, manifest.version];
		}),
	);
}

function env(name) {
	return process.env[name] || "";
}

function main() {
	const eventName = env("EVENT_NAME");
	const candidateSha = eventName === "workflow_run" ? env("UPSTREAM_HEAD_SHA") : env("GITHUB_SHA_VALUE");
	assertCommitSha(candidateSha, "Release candidate");
	const buildSha = runGit(["rev-parse", "--verify", `${candidateSha}^{commit}`]);
	assertCommitSha(buildSha, "Resolved build SHA");
	const checkedOutSha = runGit(["rev-parse", "HEAD"]);
	if (checkedOutSha !== buildSha) throw new Error(`Checked out ${checkedOutSha}, expected ${buildSha}`);

	const packageVersions = readPackageVersions();
	const productionVersion = assertLockstepVersions(packageVersions);
	const existingTagSha = runGit(
		["rev-parse", "--verify", `refs/tags/v${productionVersion}^{commit}`],
		true,
	);
	if (existingTagSha) assertCommitSha(existingTagSha, "Existing tag SHA");

	const context = resolveReleaseContext({
		buildSha,
		defaultBranch: env("DEFAULT_BRANCH"),
		eventName,
		existingTagSha,
		inputReleaseTag: env("INPUT_RELEASE_TAG"),
		packageVersions,
		refName: env("REF_NAME"),
		refType: env("REF_TYPE"),
		repository: env("GITHUB_REPOSITORY"),
		runAttempt: env("RUN_ATTEMPT"),
		runNumber: env("RUN_NUMBER"),
		workflowRun: {
			conclusion: env("UPSTREAM_CONCLUSION"),
			event: env("UPSTREAM_EVENT"),
			headBranch: env("UPSTREAM_HEAD_BRANCH"),
			headRepository: env("UPSTREAM_HEAD_REPOSITORY"),
			headSha: env("UPSTREAM_HEAD_SHA"),
			workflowPath: env("UPSTREAM_WORKFLOW_PATH"),
		},
	});

	const outputPath = env("GITHUB_OUTPUT");
	if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
	const outputs = {
		beta_version: context.betaVersion,
		build_sha: context.buildSha,
		production_version: context.productionVersion,
		publish_beta: String(context.publishBeta),
		publish_production: String(context.publishProduction),
		trigger: context.trigger,
	};
	appendFileSync(outputPath, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
	console.log(`Build SHA: ${context.buildSha}`);
	console.log(`Production: ${context.publishProduction} v${context.productionVersion}`);
	console.log(`Beta: ${context.publishBeta} ${context.betaVersion ? `v${context.betaVersion}` : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
