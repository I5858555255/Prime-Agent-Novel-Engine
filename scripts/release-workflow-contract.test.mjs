import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dryRun = readFileSync(new URL("release-dry-run.mjs", import.meta.url), "utf8");
const legacyRelease = readFileSync(new URL("release.mjs", import.meta.url), "utf8");
const legacySync = readFileSync(new URL("sync-versions.js", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const rollbackWorkflow = readFileSync(new URL("../.github/workflows/rollback-release.yml", import.meta.url), "utf8");

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

test("release workflow publishes from main or an immutable retry tag, never a tag push", () => {
	assert.doesNotMatch(releaseWorkflow, /^\s+tags:/m);
	assert.match(releaseWorkflow, /operation:/);
	assert.match(releaseWorkflow, /retry-production/);
	assert.match(releaseWorkflow, /node scripts\/resolve-release-context\.mjs/);
	assert.doesNotMatch(releaseWorkflow, /Production release tag to create or update/);
	assert.match(releaseWorkflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
	assert.match(releaseWorkflow, /path: release-tooling/);
	assert.match(releaseWorkflow, /path: release-source/);
	assert.match(releaseWorkflow, /PRIME_AGENT_RELEASE_SOURCE_ROOT:/);
	assert.match(releaseWorkflow, /node \.\.\/release-tooling\/scripts\/publish-release\.mjs production/);
});

test("production publication compares immutable assets and commits latest.json last", () => {
	assert.match(releaseWorkflow, /node \.\.\/release-tooling\/scripts\/publish-release\.mjs production/);
	assert.doesNotMatch(releaseWorkflow, /gh release upload[^\n]*--clobber/);
	const productionStep = releaseWorkflow.indexOf("node ../release-tooling/scripts/publish-release.mjs production");
	const betaStep = releaseWorkflow.indexOf("node ../release-tooling/scripts/publish-release.mjs beta");
	assert.ok(productionStep > -1);
	assert.ok(betaStep > productionStep);
});

test("rollback is a separately protected pointer-only workflow", () => {
	assert.match(rollbackWorkflow, /^name: Rollback Prime Agent stable channel$/m);
	assert.match(rollbackWorkflow, /environment: production/);
	assert.match(rollbackWorkflow, /ROLLBACK vX\.Y\.Z/);
	assert.match(rollbackWorkflow, /node scripts\/publish-release\.mjs rollback/);
	assert.doesNotMatch(rollbackWorkflow, /gh release (?:create|edit|upload)|git (?:tag|push)|npm publish/);
});
