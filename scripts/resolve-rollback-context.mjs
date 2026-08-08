#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { parseReleaseComment, validateRollbackRequest } from "./lib/release-lifecycle.mjs";

try {
	const command = parseReleaseComment({
		actorPermission: process.env.ACTOR_PERMISSION,
		body: process.env.COMMENT_BODY,
		defaultBranch: process.env.DEFAULT_BRANCH,
		expectedOperation: "rollback-production",
		workflowRef: process.env.WORKFLOW_REF,
	});
	validateRollbackRequest(command.releaseTag, command.confirmation);
	const tagResult = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${command.releaseTag}^{commit}`], {
		encoding: "utf8",
		stdio: "pipe",
	});
	if (tagResult.status !== 0) throw new Error(`Rollback tag ${command.releaseTag} does not exist`);
	const sourceSha = tagResult.stdout.trim();
	if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error(`Rollback tag has an invalid target: ${sourceSha}`);
	const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, `origin/${process.env.DEFAULT_BRANCH}`], {
		encoding: "utf8",
		stdio: "pipe",
	});
	if (ancestry.status !== 0) throw new Error(`Rollback tag ${command.releaseTag} is not on the default branch`);
	if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		`release_tag=${command.releaseTag}\nconfirmation=${command.confirmation}\nsource_sha=${sourceSha}\n`,
	);
	console.log(`Authorized rollback request for ${command.releaseTag}.`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
