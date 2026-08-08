import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { assertLockstepVersions, resolveReleaseContext } from "./resolve-release-context.mjs";
import { createPublicationContext, validatePublicationContext } from "./release-publication-context.mjs";
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
const publicationWorkflow = readFileSync(new URL("../.github/workflows/publish-release.yml", import.meta.url), "utf8");

describe("workflow contract", () => {
	it("publishes main only from completed CI and reuses full CI only for protected retry", () => {
		assert.match(releaseWorkflow, /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/);
		assert.match(releaseWorkflow, /issue_comment:/);
		assert.doesNotMatch(releaseWorkflow, /workflow_dispatch|^\s+push:|^\s+tags:/m);
		assert.match(releaseWorkflow, /full-ci:[\s\S]*outputs\.trigger == 'retry'/);
		assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
		assert.match(releaseWorkflow, /source_sha: \$\{\{ needs\.release-context\.outputs\.build_sha \}\}/);
		assert.match(releaseWorkflow, /tooling_sha: \$\{\{ github\.workflow_sha \}\}/);
	});

	it("binds CI, build, artifacts, and publication to the resolved SHA", () => {
		assert.match(ciWorkflow, /workflow_call:[\s\S]*source_sha:[\s\S]*tooling_sha:/);
		assert.ok((ciWorkflow.match(/ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/g) || []).length >= 3);
		assert.match(releaseWorkflow, /Verify release source commit[\s\S]*git rev-parse HEAD/);
		assert.match(releaseWorkflow, /name: prime-agent-production-\$\{\{ env\.BUILD_SHA \}\}/);
		assert.match(releaseWorkflow, /name: prime-agent-beta-\$\{\{ env\.BUILD_SHA \}\}/);
		assert.match(releaseWorkflow, /Capture exact release source baseline[\s\S]*- name: Build/);
		assert.match(releaseWorkflow, /Verify build and validation did not mutate release source/);
		assert.match(releaseWorkflow, /publication-context:[\s\S]*needs: release-gate/);
		assert.match(releaseWorkflow, /name: prime-agent-publication-context/);
		assert.match(publicationWorkflow, /workflow_run:\n\s+workflows: \[Release Prime Agent\]/);
	});

	it("validates source provenance before every split publication phase", () => {
		assert.match(releaseWorkflow, /--source-sha "\$BUILD_SHA"/);
		for (const phase of [
			"production-github-prepare",
			"production-r2-immutable",
			"production-github-assets",
			"production-r2-installers",
			"production-r2-promote",
			"beta-r2-immutable",
			"beta-github",
			"beta-r2-installers",
			"beta-r2-promote",
		]) {
			assert.match(publicationWorkflow, new RegExp(`publish-release\\.mjs ${phase}`));
		}
	});
});

function mainContext(overrides = {}) {
	return {
		buildSha,
		defaultBranch: "main",
		eventName: "workflow_run",
		packageVersions,
		previousVersion: "0.7.0",
		repository: "PrimeIntellect-ai/prime-agent",
		runAttempt: "2",
		runNumber: "123",
		tagTarget: undefined,
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

function retryContext(overrides = {}) {
	return {
		actorPermission: "maintain",
		buildSha,
		commentBody: "/prime-agent release retry v0.7.1",
		defaultBranch: "main",
		eventName: "issue_comment",
		packageVersions,
		tagOnDefaultBranch: true,
		workflowRef: "PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/main",
		...overrides,
	};
}

describe("release context", () => {
	it("binds a successful main CI run to its exact SHA", () => {
		assert.deepEqual(resolveReleaseContext(mainContext()), {
			betaVersion: `0.7.1-beta.123.2.${buildSha.slice(0, 7)}`,
			buildRef: buildSha,
			buildSha,
			productionVersion: "0.7.1",
			publishBeta: true,
			publishProduction: true,
			trigger: "main",
		});
	});

	it("publishes only beta when the default-branch package version is unchanged", () => {
		const context = resolveReleaseContext(mainContext({ previousVersion: "0.7.1", tagTarget: otherSha }));
		assert.equal(context.publishBeta, true);
		assert.equal(context.publishProduction, false);
		assert.equal(context.productionVersion, "");
	});

	it("rejects failed, cancelled, skipped, wrong-source, and wrong-SHA upstream CI", () => {
		for (const conclusion of ["failure", "cancelled", "skipped"]) {
			assert.throws(
				() => resolveReleaseContext(mainContext({ workflowRun: { ...mainContext().workflowRun, conclusion } })),
				/CI conclusion must be success/,
			);
		}
		for (const invalid of [
			{ event: "pull_request" },
			{ headRepository: "attacker/prime-agent" },
			{ headBranch: "feature" },
			{ workflowPath: ".github/workflows/other.yml" },
			{ headSha: otherSha },
		]) {
			assert.throws(() =>
				resolveReleaseContext(mainContext({ workflowRun: { ...mainContext().workflowRun, ...invalid } })),
			);
		}
	});

	it("accepts only an exact authorized retry bound to an existing default-branch tag", () => {
		assert.deepEqual(resolveReleaseContext(retryContext()), {
			betaVersion: "",
			buildRef: buildSha,
			buildSha,
			productionVersion: "0.7.1",
			publishBeta: false,
			publishProduction: true,
			trigger: "retry",
		});
		for (const invalid of [
			{ actorPermission: "write" },
			{ commentBody: "/prime-agent release retry v0.7.1 extra" },
			{ tagOnDefaultBranch: false },
			{ workflowRef: "PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/feature" },
		]) {
			assert.throws(() => resolveReleaseContext(retryContext(invalid)));
		}
	});

	it("rejects tag pushes, manual dispatch, invalid rerun identifiers, and lockstep drift", () => {
		assert.throws(() => resolveReleaseContext({ ...mainContext(), eventName: "push" }), /Unsupported release event/);
		assert.throws(
			() => resolveReleaseContext({ ...mainContext(), eventName: "workflow_dispatch" }),
			/Unsupported release event/,
		);
		assert.throws(() => resolveReleaseContext(mainContext({ runAttempt: "0" })), /Run attempt/);
		assert.throws(() => resolveReleaseContext(mainContext({ runNumber: "latest" })), /Run number/);
		assert.throws(() => assertLockstepVersions({ ...packageVersions, tui: "0.7.0" }), /versions must match/);
	});
});

describe("aggregate CI gate", () => {
	it("accepts only all-success Node and Python results", () => {
		assert.doesNotThrow(() =>
			verifyCiResults({ "build-check": "success", test: "success", "python-runtime": "success" }),
		);
		for (const result of ["failure", "cancelled", "skipped"]) {
			assert.throws(
				() => verifyCiResults({ "build-check": "success", test: result, "python-runtime": "success" }),
				/Required CI jobs did not succeed/,
			);
		}
	});

	it("reuses successful upstream CI for main and requires reusable CI for retry", () => {
		assert.doesNotThrow(() =>
			verifyReleaseGate({ build: "success", fullCi: "skipped", releaseContext: "success", trigger: "main" }),
		);
		assert.doesNotThrow(() =>
			verifyReleaseGate({ build: "success", fullCi: "success", releaseContext: "success", trigger: "retry" }),
		);
		for (const result of ["failure", "cancelled", "skipped"]) {
			assert.throws(
				() => verifyReleaseGate({ build: "success", fullCi: result, releaseContext: "success", trigger: "retry" }),
				/Required CI jobs did not succeed/,
			);
		}
		assert.throws(
			() => verifyReleaseGate({ build: "failure", fullCi: "skipped", releaseContext: "success", trigger: "main" }),
			/Required CI jobs did not succeed/,
		);
		assert.throws(
			() => verifyReleaseGate({ build: "success", fullCi: "success", releaseContext: "success", trigger: "main" }),
			/reuse completed upstream CI/,
		);
	});
});

function validPublicationContext(overrides = {}) {
	return createPublicationContext({
		betaVersion: "0.7.1-beta.123.2.aaaaaaa",
		buildSha,
		defaultBranch: "main",
		productionVersion: "0.7.1",
		publishBeta: true,
		publishProduction: true,
		releaseRunId: "321",
		toolingSha: buildSha,
		...overrides,
	});
}

function validPublicationUpstream(overrides = {}) {
	return {
		conclusion: "success",
		defaultBranch: "main",
		displayTitle: `Prime Agent release candidate ${buildSha}`,
		event: "workflow_run",
		headBranch: "main",
		headRepository: "PrimeIntellect-ai/prime-agent",
		headSha: buildSha,
		path: ".github/workflows/build-binaries.yml",
		repository: "PrimeIntellect-ai/prime-agent",
		runId: "321",
		...overrides,
	};
}

describe("publication context gate", () => {
	it("accepts only an exact successful release-run artifact", () => {
		assert.deepEqual(validatePublicationContext(validPublicationContext(), validPublicationUpstream()),
			validPublicationContext());
	});

	it("rejects noncanonical upstream workflow metadata", () => {
		for (const invalid of [
			{ conclusion: "failure" },
			{ displayTitle: "Rejected Prime Agent release event 321" },
			{ event: "push" },
			{ headBranch: "feature" },
			{ headRepository: "attacker/prime-agent" },
			{ path: ".github/workflows/other.yml" },
			{ runId: "999" },
			{ headSha: otherSha },
		]) {
			assert.throws(() => validatePublicationContext(validPublicationContext(), validPublicationUpstream(invalid)));
		}
	});

	it("rejects malformed, mismatched, or disabled publication artifacts", () => {
		assert.throws(() => validatePublicationContext({ ...validPublicationContext(), unexpected: true }, validPublicationUpstream()));
		assert.throws(() => validatePublicationContext({ ...validPublicationContext(), releaseRunId: "999" }, validPublicationUpstream()));
		assert.throws(() => validatePublicationContext({ ...validPublicationContext(), toolingSha: otherSha }, validPublicationUpstream()));
		assert.throws(() =>
			createPublicationContext({
				...validPublicationContext(),
				betaVersion: "",
				productionVersion: "",
				publishBeta: false,
				publishProduction: false,
			}),
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
				package: "prime-agent",
				tarball: `releases/v${version}/prime-agent-${version}.tgz`,
				tarballs: tarballs.map(({ name, ...entry }) => ({ package: name, ...entry })),
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(directory, "release-provenance.json"),
		`${JSON.stringify(
			{
				version: `v${version}`,
				channel,
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
		const remoteDirectory = mkdtempSync(join(tmpdir(), "prime-agent-remote-release-"));
		temporaryDirectories.push(remoteDirectory);
		const remoteChecksums = join(remoteDirectory, "SHA256SUMS");
		const local = readFileSync(join(fixture.directory, "SHA256SUMS"), "utf8");
		writeFileSync(remoteChecksums, `${local[0] === "f" ? "e" : "f"}${local.slice(1)}`);
		assert.throws(
			() => verifyReleaseArtifacts({ ...fixture, remoteChecksums, sourceSha: buildSha }),
			/Immutable release hash drift/,
		);
	});

	it("refuses immutable remote source-manifest drift", () => {
		const fixture = createArtifactFixture();
		const remoteDirectory = mkdtempSync(join(tmpdir(), "prime-agent-remote-release-"));
		temporaryDirectories.push(remoteDirectory);
		const remoteManifest = join(remoteDirectory, "release-provenance.json");
		const manifest = JSON.parse(readFileSync(join(fixture.directory, "release-provenance.json"), "utf8"));
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
