import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	isGitHubNotFoundError,
	isR2MissingObjectError,
	isR2PreconditionFailure,
	readPublicGitHubBranchSha,
	runCommand,
} from "./lib/release-command.mjs";

function withFailingCommand(callback) {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-release-command-"));
	const fixture = join(root, "fail.mjs");
	writeFileSync(
		fixture,
		"process.stderr.write(process.argv[2]); process.exit(Number.parseInt(process.argv[3], 10));\n",
	);
	try {
		callback((message, status, options) => runCommand(process.execPath, [fixture, message, String(status)], options));
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

test("GitHub reads accept only a structured HTTP 404 as absence", () => {
	withFailingCommand((fail) => {
		assert.equal(fail("gh: release not found (HTTP 404)\n", 1, { acceptFailure: isGitHubNotFoundError }), undefined);
		for (const message of [
			"gh: HTTP 401: Bad credentials (HTTP 401)\n",
			"gh: Resource not accessible by integration (HTTP 403)\n",
			"gh: API rate limit exceeded (HTTP 429)\n",
			"gh: Internal Server Error (HTTP 500)\n",
			"error connecting to api.github.com\n",
		]) {
			assert.throws(() => fail(message, 1, { acceptFailure: isGitHubNotFoundError }));
		}
	});
});

test("R2 reads accept only a structured GetObject absence", () => {
	withFailingCommand((fail) => {
		assert.equal(
			fail("An error occurred (NoSuchKey) when calling the GetObject operation: missing\n", 1, {
				acceptFailure: isR2MissingObjectError,
			}),
			undefined,
		);
		for (const message of [
			"An error occurred (AccessDenied) when calling the GetObject operation: 404 policy\n",
			"An error occurred (429) when calling the GetObject operation: throttled\n",
			"An error occurred (500) when calling the GetObject operation: unavailable\n",
			"Could not connect to the endpoint URL: https://example.invalid/404\n",
		]) {
			assert.throws(() => fail(message, 1, { acceptFailure: isR2MissingObjectError }));
		}
	});
});

test("immutable R2 writes accept only a structured PutObject precondition failure", () => {
	assert.equal(
		isR2PreconditionFailure(
			"An error occurred (PreconditionFailed) when calling the PutObject operation: already exists",
		),
		true,
	);
	for (const message of [
		"An error occurred (AccessDenied) when calling the PutObject operation: 412 policy",
		"An error occurred (500) when calling the PutObject operation: unavailable",
	]) {
		assert.equal(isR2PreconditionFailure(message), false);
	}
});

test("beta freshness resolves one exact public default-branch SHA", () => {
	const sha = "a".repeat(40);
	const runner = (command, args) => {
		assert.equal(command, "git");
		assert.deepEqual(args, [
			"ls-remote",
			"--exit-code",
			"https://github.com/PrimeIntellect-ai/prime-agent.git",
			"refs/heads/main",
		]);
		return `${sha}\trefs/heads/main`;
	};
	assert.equal(readPublicGitHubBranchSha("PrimeIntellect-ai/prime-agent", "main", runner), sha);
	assert.throws(
		() => readPublicGitHubBranchSha("PrimeIntellect-ai/prime-agent", "main", () => `${sha}\trefs/heads/other`),
		/Unable to resolve exact default-branch commit/,
	);
	assert.throws(() => readPublicGitHubBranchSha("invalid", "main", runner), /Invalid GitHub repository/);
	assert.throws(
		() => readPublicGitHubBranchSha("PrimeIntellect-ai/prime-agent", "../main", runner),
		/Invalid GitHub branch/,
	);
});
