#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createReleasePlan, parseReleaseComment } from "./lib/release-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitShaPattern = /^[0-9a-f]{40}$/;
const packageManifests = {
	root: "package.json",
	agent: "packages/agent/package.json",
	ai: "packages/ai/package.json",
	"coding-agent": "packages/coding-agent/package.json",
	tui: "packages/tui/package.json",
};

function git(args, options = {}) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
	if (result.status !== 0) {
		if (options.allowFailure) return undefined;
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function assertCommitSha(value, name) {
	if (!commitShaPattern.test(value)) {
		throw new Error(`${name} must be a full 40-character commit SHA: ${value}`);
	}
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
	return expected;
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
	const version = assertLockstepVersions(options.packageVersions);
	if (options.eventName === "workflow_run") {
		requireTrustedWorkflowRun(options);
		assertPositiveInteger(options.runNumber, "Run number");
		assertPositiveInteger(options.runAttempt, "Run attempt");
		return {
			...createReleasePlan({
				eventName: "push",
				previousVersion: options.previousVersion,
				runAttempt: options.runAttempt,
				runNumber: options.runNumber,
				sha: options.buildSha,
				tagTarget: options.tagTarget,
				version,
			}),
			buildSha: options.buildSha,
			trigger: "main",
		};
	}
	if (options.eventName === "issue_comment") {
		const command = parseReleaseComment({
			actorPermission: options.actorPermission,
			body: options.commentBody,
			defaultBranch: options.defaultBranch,
			expectedOperation: "retry-production",
			workflowRef: options.workflowRef,
		});
		return {
			...createReleasePlan({
				eventName: "issue_comment",
				operation: command.operation,
				releaseTag: command.releaseTag,
				tagOnDefaultBranch: options.tagOnDefaultBranch,
				tagTarget: options.buildSha,
				version,
			}),
			buildSha: options.buildSha,
			trigger: "retry",
		};
	}
	throw new Error(`Unsupported release event: ${options.eventName || "missing"}`);
}

function jsonAt(ref, path) {
	return JSON.parse(git(["show", `${ref}:${path}`]));
}

function packageVersionsAt(ref) {
	return Object.fromEntries(
		Object.entries(packageManifests).map(([name, path]) => [name, jsonAt(ref, path).version]),
	);
}

function resolveCommit(ref, name) {
	const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
	assertCommitSha(sha, name);
	return sha;
}

function resolveTagTarget(tag) {
	const sha = git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], { allowFailure: true });
	if (sha) assertCommitSha(sha, `Tag ${tag}`);
	return sha;
}

function isOnDefaultBranch(sha, defaultBranch) {
	return (
		git(["merge-base", "--is-ancestor", sha, `origin/${defaultBranch}`], { allowFailure: true }) !== undefined
	);
}

function env(name) {
	return process.env[name] || "";
}

function writeOutputs(context) {
	const outputPath = env("GITHUB_OUTPUT");
	if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
	const outputs = {
		beta_version: context.betaVersion,
		build_ref: context.buildRef,
		build_sha: context.buildSha,
		production_version: context.productionVersion,
		publish_beta: String(context.publishBeta),
		publish_production: String(context.publishProduction),
		trigger: context.trigger,
	};
	appendFileSync(outputPath, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
	console.log(`Build SHA: ${context.buildSha}`);
	console.log(`Production: ${context.publishProduction} ${context.productionVersion ? `v${context.productionVersion}` : ""}`);
	console.log(`Beta: ${context.publishBeta} ${context.betaVersion ? `v${context.betaVersion}` : ""}`);
}

function main() {
	const eventName = env("EVENT_NAME");
	const workflowSha = resolveCommit(env("WORKFLOW_SHA"), "Protected workflow SHA");
	const checkedOutSha = git(["rev-parse", "HEAD"]);
	if (checkedOutSha !== workflowSha) {
		throw new Error(`Protected tooling checkout is ${checkedOutSha}, expected ${workflowSha}`);
	}

	let buildSha;
	let previousVersion;
	let tagTarget;
	let tagOnDefaultBranch;
	if (eventName === "workflow_run") {
		buildSha = resolveCommit(env("UPSTREAM_HEAD_SHA"), "Upstream CI SHA");
		const parent = git(["rev-parse", "--verify", `${buildSha}^`], { allowFailure: true });
		previousVersion = parent ? jsonAt(parent, "package.json").version : undefined;
		const version = assertLockstepVersions(packageVersionsAt(buildSha));
		tagTarget = resolveTagTarget(`v${version}`);
	} else if (eventName === "issue_comment") {
		const match = env("COMMENT_BODY").trim().match(/^\/prime-agent release retry (v0\.\d+\.\d+)$/);
		if (!match) throw new Error("Retry command must be exactly: /prime-agent release retry v0.x.y");
		buildSha = resolveTagTarget(match[1]);
		if (!buildSha) throw new Error(`Retry tag ${match[1]} does not exist`);
		tagOnDefaultBranch = isOnDefaultBranch(buildSha, env("DEFAULT_BRANCH"));
	} else {
		throw new Error(`Unsupported release event: ${eventName || "missing"}`);
	}

	const context = resolveReleaseContext({
		actorPermission: env("ACTOR_PERMISSION"),
		buildSha,
		commentBody: env("COMMENT_BODY"),
		defaultBranch: env("DEFAULT_BRANCH"),
		eventName,
		packageVersions: packageVersionsAt(buildSha),
		previousVersion,
		repository: env("GITHUB_REPOSITORY"),
		runAttempt: env("RUN_ATTEMPT"),
		runNumber: env("RUN_NUMBER"),
		tagOnDefaultBranch,
		tagTarget,
		workflowRef: env("WORKFLOW_REF"),
		workflowRun: {
			conclusion: env("UPSTREAM_CONCLUSION"),
			event: env("UPSTREAM_EVENT"),
			headBranch: env("UPSTREAM_HEAD_BRANCH"),
			headRepository: env("UPSTREAM_HEAD_REPOSITORY"),
			headSha: env("UPSTREAM_HEAD_SHA"),
			workflowPath: env("UPSTREAM_WORKFLOW_PATH"),
		},
	});
	writeOutputs(context);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
