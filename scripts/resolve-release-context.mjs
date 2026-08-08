#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { createReleasePlan, validateReleaseRepository } from "./lib/release-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(args, options = {}) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
	if (result.status !== 0) {
		if (options.allowFailure) return undefined;
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function versionAt(ref) {
	const packageJson = git(["show", `${ref}:package.json`]);
	return JSON.parse(packageJson).version;
}

function resolveTagTarget(tag) {
	return git(["rev-parse", `refs/tags/${tag}^{commit}`], { allowFailure: true });
}

function planPush() {
	const repository = validateReleaseRepository(root);
	const beforeSha = process.env.BEFORE_SHA;
	const previousVersion =
		beforeSha && !/^0+$/.test(beforeSha) && git(["cat-file", "-e", `${beforeSha}:package.json`], { allowFailure: true }) !== undefined
			? versionAt(beforeSha)
			: undefined;
	const tagTarget = resolveTagTarget(`v${repository.version}`);
	const plan = createReleasePlan({
		eventName: "push",
		previousVersion,
		runAttempt: process.env.RUN_ATTEMPT,
		runNumber: process.env.RUN_NUMBER,
		sha: process.env.GITHUB_SHA_VALUE,
		tagTarget,
		version: repository.version,
	});
	if (plan.publishProduction) {
		validateReleaseRepository(root, { requireChangelogs: true, version: plan.productionVersion });
	}
	return plan;
}

function planRetry() {
	const defaultBranch = process.env.DEFAULT_BRANCH;
	if (process.env.REF_NAME !== defaultBranch) {
		throw new Error(`Manual retries must run from the default branch (${defaultBranch})`);
	}
	const releaseTag = process.env.INPUT_RELEASE_TAG;
	if (!/^v0\.\d+\.\d+$/.test(releaseTag ?? "")) {
		throw new Error(`Retry target must be an existing plain release tag like v0.7.1: ${releaseTag ?? ""}`);
	}
	const tagTarget = resolveTagTarget(releaseTag);
	const tagOnDefaultBranch =
		tagTarget !== undefined &&
		git(["merge-base", "--is-ancestor", tagTarget, `origin/${defaultBranch}`], { allowFailure: true }) !== undefined;
	const version = tagTarget ? versionAt(tagTarget) : releaseTag.slice(1);
	return createReleasePlan({
		eventName: "workflow_dispatch",
		operation: process.env.INPUT_OPERATION,
		releaseTag,
		tagOnDefaultBranch,
		tagTarget,
		version,
	});
}

function writeOutputs(plan) {
	const outputPath = process.env.GITHUB_OUTPUT;
	if (!outputPath) throw new Error("GITHUB_OUTPUT is required");
	const outputs = {
		beta_version: plan.betaVersion,
		build_ref: plan.buildRef,
		production_version: plan.productionVersion,
		publish_beta: String(plan.publishBeta),
		publish_production: String(plan.publishProduction),
	};
	appendFileSync(outputPath, Object.entries(outputs).map(([name, value]) => `${name}=${value}`).join("\n") + "\n");
	console.log(`Build ref: ${plan.buildRef}`);
	console.log(`Production: ${plan.publishProduction} ${plan.productionVersion ? `v${plan.productionVersion}` : ""}`);
	console.log(`Beta: ${plan.publishBeta} ${plan.betaVersion ? `v${plan.betaVersion}` : ""}`);
}

try {
	const eventName = process.env.EVENT_NAME;
	const plan = eventName === "push" ? planPush() : eventName === "workflow_dispatch" ? planRetry() : undefined;
	if (!plan) throw new Error(`Unsupported release event: ${eventName ?? ""}`);
	writeOutputs(plan);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
