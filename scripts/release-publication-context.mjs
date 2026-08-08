#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const shaPattern = /^[0-9a-f]{40}$/;
const stableVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const betaVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+\.[0-9]+\.[0-9a-f]{7}$/;
const allowedReleaseEvents = new Set(["issue_comment", "workflow_run"]);
const contextKeys = [
	"betaVersion",
	"buildSha",
	"defaultBranch",
	"productionVersion",
	"publishBeta",
	"publishProduction",
	"releaseRunId",
	"schemaVersion",
	"toolingSha",
];

function requireString(value, label) {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function requireSha(value, label) {
	if (typeof value !== "string" || !shaPattern.test(value)) throw new Error(`${label} must be a 40-character SHA`);
	return value;
}

function parseBoolean(value, label) {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	throw new Error(`${label} must be true or false`);
}

function requireRunId(value, label) {
	const normalized = String(value);
	if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error(`${label} must be a positive integer`);
	return normalized;
}

function requireExactKeys(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Publication context must be an object");
	}
	const actualKeys = Object.keys(value).sort();
	if (JSON.stringify(actualKeys) !== JSON.stringify(contextKeys)) {
		throw new Error(`Publication context fields must be exactly: ${contextKeys.join(", ")}`);
	}
}

export function createPublicationContext(input) {
	const publishBeta = parseBoolean(input.publishBeta, "publishBeta");
	const publishProduction = parseBoolean(input.publishProduction, "publishProduction");
	if (!publishBeta && !publishProduction) throw new Error("At least one publication channel must be enabled");
	const betaVersion = publishBeta ? requireString(input.betaVersion, "betaVersion") : input.betaVersion;
	const productionVersion = publishProduction
		? requireString(input.productionVersion, "productionVersion")
		: input.productionVersion;
	if (publishBeta && !betaVersionPattern.test(betaVersion)) throw new Error("betaVersion has an invalid format");
	if (!publishBeta && betaVersion !== "") throw new Error("betaVersion must be empty when beta publication is disabled");
	if (publishProduction && !stableVersionPattern.test(productionVersion)) {
		throw new Error("productionVersion has an invalid format");
	}
	if (!publishProduction && productionVersion !== "") {
		throw new Error("productionVersion must be empty when production publication is disabled");
	}
	return {
		betaVersion,
		buildSha: requireSha(input.buildSha, "buildSha"),
		defaultBranch: requireString(input.defaultBranch, "defaultBranch"),
		productionVersion,
		publishBeta,
		publishProduction,
		releaseRunId: requireRunId(input.releaseRunId, "releaseRunId"),
		schemaVersion: 1,
		toolingSha: requireSha(input.toolingSha, "toolingSha"),
	};
}

export function validatePublicationContext(context, upstream) {
	requireExactKeys(context);
	if (context.schemaVersion !== 1) throw new Error("Unsupported publication context schema");
	const expectedRepository = requireString(upstream.repository, "repository");
	const expectedDefaultBranch = requireString(upstream.defaultBranch, "defaultBranch");
	if (upstream.conclusion !== "success") throw new Error("Release workflow conclusion must be success");
	if (!upstream.displayTitle?.startsWith("Prime Agent release candidate ")) {
		throw new Error("Release workflow is not a publication candidate");
	}
	if (!allowedReleaseEvents.has(upstream.event)) throw new Error(`Unsupported release event: ${upstream.event}`);
	if (upstream.path !== ".github/workflows/build-binaries.yml") throw new Error("Unexpected release workflow path");
	if (upstream.headRepository !== expectedRepository) throw new Error("Release workflow repository does not match");
	if (upstream.headBranch !== expectedDefaultBranch) throw new Error("Release workflow branch does not match");
	const expectedRunId = requireRunId(upstream.runId, "upstream run ID");
	const expectedToolingSha = requireSha(upstream.headSha, "upstream SHA");
	const normalized = createPublicationContext(context);
	if (normalized.releaseRunId !== expectedRunId) throw new Error("Publication context run ID does not match");
	if (normalized.toolingSha !== expectedToolingSha) throw new Error("Publication context tooling SHA does not match");
	if (normalized.defaultBranch !== expectedDefaultBranch) throw new Error("Publication context branch does not match");
	return normalized;
}

function environmentContext() {
	return {
		betaVersion: process.env.BETA_VERSION ?? "",
		buildSha: process.env.BUILD_SHA,
		defaultBranch: process.env.DEFAULT_BRANCH,
		productionVersion: process.env.PRODUCTION_VERSION ?? "",
		publishBeta: process.env.PUBLISH_BETA,
		publishProduction: process.env.PUBLISH_PRODUCTION,
		releaseRunId: process.env.RELEASE_RUN_ID,
		toolingSha: process.env.TOOLING_SHA,
	};
}

function upstreamEnvironment() {
	return {
		conclusion: process.env.UPSTREAM_CONCLUSION,
		defaultBranch: process.env.DEFAULT_BRANCH,
		displayTitle: process.env.UPSTREAM_DISPLAY_TITLE,
		event: process.env.UPSTREAM_EVENT,
		headBranch: process.env.UPSTREAM_HEAD_BRANCH,
		headRepository: process.env.UPSTREAM_HEAD_REPOSITORY,
		headSha: process.env.UPSTREAM_HEAD_SHA,
		path: process.env.UPSTREAM_WORKFLOW_PATH,
		repository: process.env.GITHUB_REPOSITORY,
		runId: process.env.UPSTREAM_RUN_ID,
	};
}

function writeOutputs(context) {
	const outputPath = requireString(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
	appendFileSync(
		outputPath,
		[
			`beta_version=${context.betaVersion}`,
			`build_sha=${context.buildSha}`,
			`default_branch=${context.defaultBranch}`,
			`production_version=${context.productionVersion}`,
			`publish_beta=${context.publishBeta}`,
			`publish_production=${context.publishProduction}`,
			`source_run_id=${context.releaseRunId}`,
			`tooling_sha=${context.toolingSha}`,
			"",
		].join("\n"),
	);
}

function main() {
	const [operation, contextPath] = process.argv.slice(2);
	if (!contextPath || !new Set(["create", "validate"]).has(operation)) {
		throw new Error("Usage: release-publication-context.mjs <create|validate> <context-path>");
	}
	if (operation === "create") {
		writeFileSync(contextPath, `${JSON.stringify(createPublicationContext(environmentContext()), null, 2)}\n`);
		return;
	}
	const context = JSON.parse(readFileSync(contextPath, "utf8"));
	writeOutputs(validatePublicationContext(context, upstreamEnvironment()));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
