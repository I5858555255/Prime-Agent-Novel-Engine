#!/usr/bin/env node

import { appendFileSync } from "node:fs";

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
	if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
	appendFileSync(
		process.env.GITHUB_OUTPUT,
		`release_tag=${command.releaseTag}\nconfirmation=${command.confirmation}\n`,
	);
	console.log(`Authorized rollback request for ${command.releaseTag}.`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
