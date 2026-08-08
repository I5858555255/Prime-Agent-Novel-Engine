import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { assertLockstepVersions, resolveReleaseContext } from "./resolve-release-context.mjs";
import { verifyCiResults } from "./verify-ci-results.mjs";
import { verifyReleaseGate } from "./verify-release-gate.mjs";
import { verifyReleaseArtifacts } from "./verify-release-artifacts.mjs";

const buildSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const packageVersions = {
	root: "0.7.1",
	agent: "0.7.1",
	ai: "0.7.1",
	"coding-agent": "0.7.1",
	tui: "0.7.1",
};
const releaseWorkflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("workflow contract", () => {
	it("publishes main only from completed CI and reuses full CI for tag/manual", () => {
		assert.match(releaseWorkflow, /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/);
		assert.doesNotMatch(releaseWorkflow, /push:\n\s+branches:/);
		assert.match(releaseWorkflow, /full-ci:[\s\S]*uses: \.\/\.github\/workflows\/ci\.yml/);
		assert.match(releaseWorkflow, /source_sha: \$\{\{ needs\.release-context\.outputs\.build_sha \}\}/);
	});

	it("binds CI, build, artifacts, and publication to the resolved SHA", () => {
		assert.match(ciWorkflow, /workflow_call:[\s\S]*source_sha:/);
		assert.equal((ciWorkflow.match(/ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/g) || []).length, 4);
		assert.match(readFileSync(new URL("./resolve-release-context.mjs", import.meta.url), "utf8"), /checkedOutSha !== buildSha/);
		assert.match(releaseWorkflow, /Verify release source remains exact[\s\S]*git diff --exit-code/);
		assert.match(releaseWorkflow, /name: prime-agent-production-\$\{\{ env\.BUILD_SHA \}\}/);
		assert.match(releaseWorkflow, /name: prime-agent-beta-\$\{\{ env\.BUILD_SHA \}\}/);
		assert.match(releaseWorkflow, /publish:\n\s+runs-on: ubuntu-latest\n\s+needs: release-gate/);
	});

	it("refuses local and immutable remote provenance drift before upload", () => {
		assert.match(releaseWorkflow, /--source-sha "\$BUILD_SHA"/);
		assert.match(releaseWorkflow, /--remote-checksums "\$REMOTE_SUMS"/);
		assert.match(releaseWorkflow, /--remote-manifest "\$REMOTE_MANIFEST"/);
		assert.match(releaseWorkflow, /Refusing to overwrite incomplete immutable release prefix/);
	});
});

function mainContext(overrides = {}) {
	return {
		buildSha,
		defaultBranch: "main",
		eventName: "workflow_run",
		existingTagSha: null,
		inputReleaseTag: "",
		packageVersions,
		refName: "",
		refType: "",
		repository: "PrimeIntellect-ai/prime-agent",
		runAttempt: "2",
		runNumber: "123",
		workflowRun: {
			conclusion: "success",
			event: "push",
			headBranch: "main",
			headRepository: "PrimeIntellect-ai/prime-agent",
			headSha: buildSha,
			workflowPath: ".github/workflows/ci.yml",
		},
		...overrides,
	};
}

describe("release context", () => {
	it("binds a successful main CI run to its exact SHA", () => {
		assert.deepEqual(resolveReleaseContext(mainContext()), {
			betaVersion: `0.7.1-beta.123.2.${buildSha.slice(0, 7)}`,
			buildSha,
			productionVersion: "0.7.1",
			publishBeta: true,
			publishProduction: true,
			trigger: "main",
		});
	});

	it("does not republish a production version tagged at another main SHA", () => {
		const context = resolveReleaseContext(mainContext({ existingTagSha: otherSha }));
		assert.equal(context.publishBeta, true);
		assert.equal(context.publishProduction, false);
	});

	it("rejects failed, cancelled, and skipped CI", () => {
		for (const conclusion of ["failure", "cancelled", "skipped"]) {
			assert.throws(
				() =>
					resolveReleaseContext(
						mainContext({ workflowRun: { ...mainContext().workflowRun, conclusion } }),
					),
				/CI conclusion must be success/,
			);
		}
	});

	it("rejects PR, fork, branch, workflow-path, and SHA mismatches", () => {
		const invalidRuns = [
			{ event: "pull_request" },
			{ headRepository: "attacker/prime-agent" },
			{ headBranch: "feature" },
			{ workflowPath: ".github/workflows/other.yml" },
			{ headSha: otherSha },
		];
		for (const invalid of invalidRuns) {
			assert.throws(() =>
				resolveReleaseContext(
					mainContext({ workflowRun: { ...mainContext().workflowRun, ...invalid } }),
				),
			);
		}
	});

	it("accepts exact tag and default-branch manual releases", () => {
		const tag = resolveReleaseContext({
			...mainContext(),
			eventName: "push",
			existingTagSha: buildSha,
			refName: "v0.7.1",
			refType: "tag",
		});
		assert.equal(tag.trigger, "tag");
		assert.equal(tag.publishProduction, true);

		const manual = resolveReleaseContext({
			...mainContext(),
			eventName: "workflow_dispatch",
			existingTagSha: null,
			inputReleaseTag: "v0.7.1",
			refName: "main",
		});
		assert.equal(manual.trigger, "manual");
		assert.equal(manual.publishProduction, true);
	});

	it("rejects tag, manual branch, and package-version mismatches", () => {
		assert.throws(
			() =>
				resolveReleaseContext({
					...mainContext(),
					eventName: "push",
					refName: "v0.7.2",
					refType: "tag",
				}),
			/tag v0.7.2 does not match/i,
		);
		assert.throws(
			() =>
				resolveReleaseContext({
					...mainContext(),
					eventName: "workflow_dispatch",
					inputReleaseTag: "v0.7.1",
					refName: "feature",
				}),
			/default branch/,
		);
		assert.throws(
			() => assertLockstepVersions({ ...packageVersions, tui: "0.7.0" }),
			/versions must match/,
		);
	});

	it("rejects invalid rerun identifiers", () => {
		assert.throws(() => resolveReleaseContext(mainContext({ runAttempt: "0" })), /Run attempt/);
		assert.throws(() => resolveReleaseContext(mainContext({ runNumber: "latest" })), /Run number/);
	});
});

describe("aggregate CI gate", () => {
	it("accepts only all-success results", () => {
		assert.doesNotThrow(() =>
			verifyCiResults({ "build-check": "success", test: "success", "python-runtime": "success" }),
		);
	});

	it("rejects a failed shard or cancelled/skipped required job", () => {
		for (const result of ["failure", "cancelled", "skipped"]) {
			assert.throws(
				() => verifyCiResults({ "build-check": "success", test: result, "python-runtime": "success" }),
				/new Error|Required CI jobs did not succeed/,
			);
		}
	});

	it("requires upstream CI for main and reusable CI for tag/manual releases", () => {
		assert.doesNotThrow(() =>
			verifyReleaseGate({ build: "success", fullCi: "skipped", releaseContext: "success", trigger: "main" }),
		);
		for (const trigger of ["tag", "manual"]) {
			assert.doesNotThrow(() =>
				verifyReleaseGate({ build: "success", fullCi: "success", releaseContext: "success", trigger }),
			);
		}
	});

	it("rejects bypassed or unsuccessful release gates", () => {
		for (const result of ["failure", "cancelled", "skipped"]) {
			assert.throws(
				() =>
					verifyReleaseGate({ build: "success", fullCi: result, releaseContext: "success", trigger: "tag" }),
				/Required CI jobs did not succeed/,
			);
		}
		assert.throws(
			() =>
				verifyReleaseGate({ build: "failure", fullCi: "skipped", releaseContext: "success", trigger: "main" }),
			/Required CI jobs did not succeed/,
		);
		assert.throws(
			() =>
				verifyReleaseGate({ build: "success", fullCi: "success", releaseContext: "success", trigger: "main" }),
			/reuse completed upstream CI/,
		);
	});
});

const temporaryDirectories = [];

function checksum(value) {
	return createHash("sha256").update(value).digest("hex");
}

function createArtifactFixture(channel = "stable") {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-"));
	temporaryDirectories.push(directory);
	const version = channel === "stable" ? "0.7.1" : "0.7.1-beta.123.2.aaaaaaa";
	const definitions = [
		["prime-agent", "prime-agent"],
		["prime-agent-ai", "prime-agent-ai"],
		["prime-agent-core", "prime-agent-core"],
		["prime-agent-tui", "prime-agent-tui"],
	].map(([name, prefix]) => ({ file: `${prefix}-${version}.tgz`, name }));
	const tarballs = definitions.map((entry) => {
		const content = `content:${entry.file}`;
		writeFileSync(join(directory, entry.file), content);
		return { ...entry, sha256: checksum(content) };
	});
	writeFileSync(
		join(directory, "SHA256SUMS"),
		`${tarballs
			.slice()
			.sort((left, right) => left.file.localeCompare(right.file))
			.map((entry) => `${entry.sha256}  ${entry.file}`)
			.join("\n")}\n`,
	);
	writeFileSync(join(directory, channel), `v${version}\n`);
	const manifestName = channel === "stable" ? "latest.json" : "beta.json";
	writeFileSync(
		join(directory, manifestName),
		`${JSON.stringify(
			{
				version: `v${version}`,
				sourceSha: buildSha,
				package: "prime-agent",
				tarball: `releases/v${version}/prime-agent-${version}.tgz`,
				tarballs: tarballs.map(({ name, ...entry }) => ({ package: name, ...entry })),
			},
			null,
			2,
		)}\n`,
	);
	return { channel, directory, manifestName, version };
}

afterEach(() => {
	while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
});

describe("release artifact provenance", () => {
	it("accepts an exact source SHA and package/hash set", () => {
		for (const channel of ["stable", "beta"]) {
			const fixture = createArtifactFixture(channel);
			assert.doesNotThrow(() => verifyReleaseArtifacts({ ...fixture, sourceSha: buildSha }));
		}
	});

	it("rejects local tampering and source-SHA drift", () => {
		const fixture = createArtifactFixture();
		writeFileSync(join(fixture.directory, `prime-agent-${fixture.version}.tgz`), "tampered");
		assert.throws(() => verifyReleaseArtifacts({ ...fixture, sourceSha: buildSha }), /Checksum mismatch/);

		const clean = createArtifactFixture();
		assert.throws(() => verifyReleaseArtifacts({ ...clean, sourceSha: otherSha }), /source SHA/);
	});

	it("refuses immutable remote checksum drift", () => {
		const fixture = createArtifactFixture();
		const remoteChecksums = join(fixture.directory, "REMOTE_SHA256SUMS");
		const local = readFileSync(join(fixture.directory, "SHA256SUMS"), "utf8");
		writeFileSync(remoteChecksums, `${local[0] === "f" ? "e" : "f"}${local.slice(1)}`);
		assert.throws(
			() => verifyReleaseArtifacts({ ...fixture, remoteChecksums, sourceSha: buildSha }),
			/Immutable release hash drift/,
		);
	});

	it("refuses immutable remote source-manifest drift", () => {
		const fixture = createArtifactFixture();
		const remoteManifest = join(fixture.directory, "REMOTE_MANIFEST.json");
		const manifest = JSON.parse(readFileSync(join(fixture.directory, fixture.manifestName), "utf8"));
		writeFileSync(remoteManifest, `${JSON.stringify({ ...manifest, sourceSha: otherSha }, null, 2)}\n`);
		assert.throws(
			() => verifyReleaseArtifacts({ ...fixture, remoteManifest, sourceSha: buildSha }),
			/Immutable release manifest drift/,
		);
	});

	it("rejects incomplete or unexpected artifact lists", () => {
		const fixture = createArtifactFixture();
		const checksumPath = join(fixture.directory, "SHA256SUMS");
		const lines = readFileSync(checksumPath, "utf8").trim().split("\n");
		writeFileSync(checksumPath, `${lines.slice(1).join("\n")}\n`);
		assert.throws(() => verifyReleaseArtifacts({ ...fixture, sourceSha: buildSha }), /file set mismatch/);
	});
});
