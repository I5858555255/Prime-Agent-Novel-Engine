import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dryRun = readFileSync(new URL("release-dry-run.mjs", import.meta.url), "utf8");
const legacyRelease = readFileSync(new URL("release.mjs", import.meta.url), "utf8");
const legacySync = readFileSync(new URL("sync-versions.js", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const publicationWorkflow = readFileSync(new URL("../.github/workflows/publish-release.yml", import.meta.url), "utf8");
const rollbackWorkflow = readFileSync(new URL("../.github/workflows/rollback-release.yml", import.meta.url), "utf8");
const rollbackResolver = readFileSync(new URL("resolve-rollback-context.mjs", import.meta.url), "utf8");
const publisher = readFileSync(new URL("publish-release.mjs", import.meta.url), "utf8");
const packageContract = readFileSync(new URL("check-release-package-contract.mjs", import.meta.url), "utf8");

test("legacy local release and publish commands are non-mutating tombstones", () => {
	for (const scriptName of [
		"publish",
		"publish:dry",
		"release:major",
		"release:minor",
		"release:patch",
		"version:major",
		"version:minor",
		"version:patch",
		"version:set",
	]) {
		assert.match(packageJson.scripts[scriptName], /^node scripts\/release\.mjs/);
	}
	assert.doesNotMatch(legacyRelease, /execSync|spawnSync|writeFile|npm publish|git (?:commit|tag|push)/);
	assert.match(legacyRelease, /release:prepare/);
	assert.match(legacyRelease, /release:dry-run/);
	assert.doesNotMatch(legacySync, /writeFile|npm version|npm install/);
	assert.doesNotMatch(dryRun, /npm publish|git (?:commit|tag|push)|\bgh\b|\baws\b/);
});

test("release authority is successful canonical CI or an authorized immutable retry", () => {
	assert.match(releaseWorkflow, /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/);
	assert.match(releaseWorkflow, /issue_comment:/);
	assert.doesNotMatch(releaseWorkflow, /workflow_dispatch|^\s+push:|^\s+tags:/m);
	assert.match(releaseWorkflow, /\/prime-agent release retry/);
	assert.match(releaseWorkflow, /collaborators\/\$\{ACTOR\}\/permission/);
	assert.match(releaseWorkflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
	assert.match(releaseWorkflow, /path: release-tooling/);
	assert.match(releaseWorkflow, /path: release-source/);
	assert.match(releaseWorkflow, /full-ci:[\s\S]*outputs\.trigger == 'retry'/);
	assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
	assert.match(releaseWorkflow, /publication-context:[\s\S]*needs: release-gate/);
	assert.match(releaseWorkflow, /name: prime-agent-publication-context/);
	assert.match(publicationWorkflow, /workflow_run:\n\s+workflows: \[Release Prime Agent\]/);

	const authorizationStart = publicationWorkflow.indexOf("  authorize-publication:");
	const firstMutationStart = publicationWorkflow.indexOf("  production-github-prepare:");
	assert.ok(authorizationStart > -1 && firstMutationStart > authorizationStart);
	const authorization = publicationWorkflow.slice(authorizationStart, firstMutationStart);
	assert.match(authorization, /actions: read/);
	assert.match(authorization, /contents: read/);
	assert.match(authorization, /workflow_run\.conclusion == 'success'/);
	assert.match(authorization, /workflow_run\.path == '\.github\/workflows\/build-binaries\.yml'/);
	assert.match(authorization, /workflow_run\.head_repository\.full_name == github\.repository/);
	assert.match(authorization, /workflow_run\.display_title/);
	assert.match(authorization, /actions\/runs\/\$\{SOURCE_RUN_ID\}\/artifacts/);
	assert.match(authorization, /prime-agent-publication-context/);
	assert.match(authorization, /release-publication-context\.mjs validate/);
	assert.match(authorization, /UPSTREAM_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
	assert.match(authorization, /UPSTREAM_HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
	assert.doesNotMatch(authorization, /environment: production|group: release-prime-agent|secrets\.R2_/);
	assert.match(publicationWorkflow.slice(0, authorizationStart), /group:[\s\S]*release-prime-agent/);
});

test("release artifacts, verification, and publication use one exact source SHA", () => {
	assert.match(releaseWorkflow, /--source-sha "\$BUILD_SHA"/);
	assert.match(packageContract, /--source-sha["'],\s*contractSourceSha/);
	assert.match(releaseWorkflow, /prime-agent-production-\$\{\{ env\.BUILD_SHA \}\}/);
	assert.match(releaseWorkflow, /prime-agent-beta-\$\{\{ env\.BUILD_SHA \}\}/);
	assert.match(releaseWorkflow, /Verify release source commit[\s\S]*git rev-parse HEAD/);
	const baselineIndex = releaseWorkflow.indexOf("Capture exact release source baseline");
	const buildIndex = releaseWorkflow.indexOf("- name: Build");
	const finalGuardIndex = releaseWorkflow.indexOf("Verify build and validation did not mutate release source");
	assert.ok(baselineIndex > -1 && baselineIndex < buildIndex);
	assert.ok(finalGuardIndex > buildIndex);
	assert.match(releaseWorkflow, /release-source-worktree\.diff[\s\S]*release-final-worktree\.diff/);
	assert.match(releaseWorkflow, /release-gate:[\s\S]*needs: \[release-context, full-ci, build\]/);
	assert.match(releaseWorkflow, /publication-context:[\s\S]*needs: release-gate/);
	assert.match(releaseWorkflow, /release-publication-context\.mjs create publication-context\.json/);
	assert.match(releaseWorkflow, /BUILD_SHA: \$\{\{ needs\.release-gate\.outputs\.build_sha \}\}/);
	assert.match(releaseWorkflow, /TOOLING_SHA: \$\{\{ github\.workflow_sha \}\}/);
});

test("production and beta mutation phases preserve ordering and credential separation", () => {
	const orderedNames = [
		"Prepare production GitHub release",
		"Publish production immutable objects to R2",
		"Publish production GitHub assets",
		"Publish production installers to R2",
		"Promote production channel in R2",
		"Publish beta immutable objects to R2",
		"Advance beta GitHub release",
		"Advance beta installers in R2",
		"Advance beta channel in R2",
	];
	let previous = -1;
	for (const name of orderedNames) {
		const index = publicationWorkflow.indexOf(`- name: ${name}`);
		assert.ok(index > previous, `${name} must follow the preceding publication phase`);
		previous = index;
	}
	assert.doesNotMatch(publicationWorkflow, /gh release upload[^\n]*--clobber/);
	assert.match(publisher, /putImmutable/);
	assert.match(publisher, /ensureProductionAssets/);
	assert.match(publisher, /prime-agent-beta-final-/);
	assert.match(publisher, /verifyAssetDirectory\(artifactsDir, finalDir, expectedNames\)/);
	assert.match(publisher, /promoteChannel\(artifactsDir, "stable"/);
});

test("rollback authorizes before protected resources and splits GitHub verification from R2 promotion", () => {
	assert.match(rollbackWorkflow, /^name: Rollback Prime Agent stable channel$/m);
	assert.doesNotMatch(rollbackWorkflow, /workflow_dispatch/);
	assert.match(rollbackWorkflow, /\/prime-agent release rollback/);
	assert.match(rollbackWorkflow, /collaborators\/\$\{ACTOR\}\/permission/);
	assert.match(rollbackResolver, /source_sha/);
	const authorizationJob = rollbackWorkflow.indexOf("  authorize:");
	const rollbackJob = rollbackWorkflow.indexOf("  rollback:");
	assert.ok(authorizationJob > -1);
	assert.ok(rollbackJob > authorizationJob);
	const authorization = rollbackWorkflow.slice(authorizationJob, rollbackJob);
	assert.doesNotMatch(authorization, /environment: production|group: release-prime-agent|secrets\.R2_/);
	const mutation = rollbackWorkflow.slice(rollbackJob);
	assert.match(mutation, /needs: authorize/);
	assert.match(mutation, /environment: production/);
	assert.match(mutation, /group: release-prime-agent/);
	assert.match(mutation, /rollback-github-verify/);
	assert.match(mutation, /rollback-r2-promote/);
	assert.equal(
		mutation.match(/--source-sha "\$\{\{ needs\.authorize\.outputs\.source_sha \}\}"/g)?.length,
		2,
	);
	const githubStep = mutation.slice(
		mutation.indexOf("- name: Verify rollback GitHub release"),
		mutation.indexOf("- name: Promote verified stable pointers in R2"),
	);
	assert.doesNotMatch(githubStep, /secrets\.R2_/);
	const r2Step = mutation.slice(mutation.indexOf("- name: Promote verified stable pointers in R2"));
	assert.doesNotMatch(r2Step, /GH_TOKEN|secrets\.GITHUB_TOKEN/);
});
