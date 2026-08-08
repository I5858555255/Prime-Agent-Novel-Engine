import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	RELEASE_PACKAGE_DIRS,
	bumpVersion,
	createReleasePlan,
	decideImmutableWrite,
	parseReleaseComment,
	prepareRelease,
	promotionKeys,
	validateReleaseRepository,
	validateRollbackRequest,
	verifyReleaseArtifacts,
} from "./lib/release-lifecycle.mjs";

const packageNames = {
	agent: "@earendil-works/pi-agent-core",
	ai: "@earendil-works/pi-ai",
	"coding-agent": "@earendil-works/pi-coding-agent",
	tui: "@earendil-works/pi-tui",
};
const sourceSha = "a".repeat(40);

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepositoryFixture(version = "0.7.1") {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-release-test-"));
	mkdirSync(join(root, "packages"), { recursive: true });
	const rootPackage = {
		name: "prime-agent",
		private: true,
		version,
		dependencies: { "@earendil-works/pi-coding-agent": `^${version}` },
	};
	writeJson(join(root, "package.json"), rootPackage);

	const lockPackages = {
		"": structuredClone(rootPackage),
	};
	for (const packageDir of RELEASE_PACKAGE_DIRS) {
		const shortName = packageDir.replace("packages/", "");
		const dependencies = {};
		if (shortName === "agent") dependencies[packageNames.ai] = `^${version}`;
		if (shortName === "coding-agent") {
			dependencies[packageNames.agent] = `^${version}`;
			dependencies[packageNames.ai] = `^${version}`;
			dependencies[packageNames.tui] = `^${version}`;
		}
		const packageJson = { name: packageNames[shortName], version, dependencies };
		mkdirSync(join(root, packageDir), { recursive: true });
		writeJson(join(root, packageDir, "package.json"), packageJson);
		writeFileSync(join(root, packageDir, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n- Changed fixture.\n\n## [${version}] - 2026-08-07\n`);
		lockPackages[packageDir] = structuredClone(packageJson);
	}

	const privateDir = join(root, "packages", "private-example");
	mkdirSync(privateDir, { recursive: true });
	writeJson(join(privateDir, "package.json"), { name: "private-example", private: true, version: "9.9.9" });
	writeJson(join(root, "package-lock.json"), {
		name: "prime-agent",
		version,
		lockfileVersion: 3,
		packages: lockPackages,
	});
	return root;
}

function fileSha256(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function createArtifactFixture(version = "0.7.2", channel = "stable", options = {}) {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-artifacts-test-"));
	const artifactsDir = join(root, "artifacts");
	mkdirSync(artifactsDir, { recursive: true });
	const packageFixtures = [
		{ file: `prime-agent-ai-${version}.tgz`, name: "prime-agent-ai" },
		{ file: `prime-agent-core-${version}.tgz`, name: "prime-agent-core", dependencies: { [packageNames.ai]: `https://release.invalid/releases/v${version}/prime-agent-ai-${version}.tgz` } },
		{ file: `prime-agent-tui-${version}.tgz`, name: "prime-agent-tui" },
		{
			file: `prime-agent-${version}.tgz`,
			name: "prime-agent",
			bin: { "prime-agent": "dist/bundle/cli.js" },
			dependencies: options.omitCliInternalDependencies
				? {}
				: {
						[packageNames.agent]: `https://release.invalid/releases/v${version}/prime-agent-core-${version}.tgz`,
						[packageNames.ai]: `https://release.invalid/releases/v${version}/prime-agent-ai-${version}.tgz`,
						[packageNames.tui]: `https://release.invalid/releases/v${version}/prime-agent-tui-${version}.tgz`,
					},
			piConfig: { configDir: ".prime/agent", name: "prime-agent" },
		},
	];
	const tarballs = [];
	for (const packageFixture of packageFixtures) {
		const staging = join(root, `staging-${packageFixture.name}`, "package");
		mkdirSync(staging, { recursive: true });
		writeJson(join(staging, "package.json"), { ...packageFixture, file: undefined, version });
		const artifactPath = join(artifactsDir, packageFixture.file);
		const tar = spawnSync("tar", ["-czf", artifactPath, "-C", dirname(staging), "package"], { encoding: "utf8" });
		assert.equal(tar.status, 0, tar.stderr);
		tarballs.push({ package: packageFixture.name, file: packageFixture.file, sha256: fileSha256(artifactPath) });
	}
	tarballs.sort((left, right) => left.file.localeCompare(right.file));
	writeFileSync(join(artifactsDir, "SHA256SUMS"), tarballs.map(({ file, sha256 }) => `${sha256}  ${file}`).join("\n") + "\n");
	const pointerName = channel;
	const manifestName = channel === "stable" ? "latest.json" : "beta.json";
	writeFileSync(join(artifactsDir, pointerName), `v${version}\n`);
	writeJson(join(artifactsDir, manifestName), {
		version: `v${version}`,
		package: "prime-agent",
		tarball: `releases/v${version}/prime-agent-${version}.tgz`,
		tarballs,
	});
	writeJson(join(artifactsDir, "release-provenance.json"), {
		version: `v${version}`,
		channel,
		sourceSha,
		package: "prime-agent",
		tarball: `releases/v${version}/prime-agent-${version}.tgz`,
		tarballs,
	});
	return { artifactsDir, root };
}

test("release versions support patch and minor but reject major releases", () => {
	assert.equal(bumpVersion("0.7.1", "patch"), "0.7.2");
	assert.equal(bumpVersion("0.7.1", "minor"), "0.8.0");
	assert.equal(bumpVersion("0.7.1", "0.9.0"), "0.9.0");
	assert.throws(() => bumpVersion("0.7.1", "major"), /major releases are not supported/i);
	assert.throws(() => bumpVersion("0.7.1", "1.0.0"), /major version must remain 0/i);
	assert.throws(() => bumpVersion("0.7.1", "0.7.1"), /newer than/i);
});

test("repository validation enforces release-package lockstep but ignores private workspaces", () => {
	const root = createRepositoryFixture();
	try {
		assert.equal(validateReleaseRepository(root, { version: "0.7.1", requireChangelogs: true }).version, "0.7.1");
		writeJson(join(root, "packages/private-example/package.json"), {
			name: "private-example",
			private: true,
			version: "10.0.0",
		});
		assert.equal(validateReleaseRepository(root, { version: "0.7.1" }).version, "0.7.1");
		const agentPath = join(root, "packages/agent/package.json");
		const agent = JSON.parse(readFileSync(agentPath, "utf8"));
		agent.version = "0.7.0";
		writeJson(agentPath, agent);
		assert.throws(() => validateReleaseRepository(root, { version: "0.7.1" }), /packages\/agent.*0\.7\.0/i);
		agent.version = "0.7.1";
		delete agent.dependencies[packageNames.ai];
		writeJson(agentPath, agent);
		assert.throws(() => validateReleaseRepository(root, { version: "0.7.1" }), /dependencies.*pi-ai.*missing/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release preparation updates only release metadata and preserves private workspaces", () => {
	const root = createRepositoryFixture();
	try {
		const privateBefore = readFileSync(join(root, "packages/private-example/package.json"), "utf8");
		const changed = prepareRelease(root, "patch", { date: "2026-08-08" });
		assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.7.2");
		assert.deepEqual(
			changed.sort(),
			[
				"package-lock.json",
				"package.json",
				...RELEASE_PACKAGE_DIRS.flatMap((packageDir) => [
					`${packageDir}/CHANGELOG.md`,
					`${packageDir}/package.json`,
				]),
			].sort(),
		);
		assert.equal(readFileSync(join(root, "packages/private-example/package.json"), "utf8"), privateBefore);
		for (const packageDir of RELEASE_PACKAGE_DIRS) {
			const changelog = readFileSync(join(root, packageDir, "CHANGELOG.md"), "utf8");
			assert.match(changelog, /^## \[Unreleased\]\n\n## \[0\.7\.2\] - 2026-08-08\n\n- Changed fixture\./m);
		}
		validateReleaseRepository(root, { version: "0.7.2", requireChangelogs: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release preparation restores every file when a replacement fails mid-transaction", () => {
	const root = createRepositoryFixture();
	const releaseFiles = [
		"package.json",
		"package-lock.json",
		...RELEASE_PACKAGE_DIRS.flatMap((packageDir) => [
			`${packageDir}/package.json`,
			`${packageDir}/CHANGELOG.md`,
		]),
	];
	const before = new Map(releaseFiles.map((path) => [path, readFileSync(join(root, path))]));
	let replacements = 0;
	try {
		assert.throws(
			() =>
				prepareRelease(root, "patch", {
					date: "2026-08-08",
					replaceFile(source, destination) {
						replacements += 1;
						if (replacements === 4) throw new Error("injected replacement failure");
						renameSync(source, destination);
					},
				}),
			/injected replacement failure/,
		);
		for (const [path, content] of before) {
			assert.deepEqual(readFileSync(join(root, path)), content, path);
		}
		for (const directory of [root, ...RELEASE_PACKAGE_DIRS.map((packageDir) => join(root, packageDir))]) {
			assert.equal(readdirSync(directory).some((name) => name.includes(".release-")), false, directory);
		}
		validateReleaseRepository(root, { version: "0.7.1", requireChangelogs: true });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("main pushes publish beta and only a strictly newer version publishes production", () => {
	const changed = createReleasePlan({
		eventName: "push",
		sha: "0123456789abcdef",
		version: "0.7.2",
		previousVersion: "0.7.1",
		runNumber: "42",
		runAttempt: "1",
		tagTarget: undefined,
	});
	assert.deepEqual(changed, {
		betaVersion: "0.7.2-beta.42.1.0123456",
		buildRef: "0123456789abcdef",
		productionVersion: "0.7.2",
		publishBeta: true,
		publishProduction: true,
	});

	const unchanged = createReleasePlan({
		eventName: "push",
		sha: "0123456789abcdef",
		version: "0.7.2",
		previousVersion: "0.7.2",
		runNumber: "43",
		runAttempt: "1",
	});
	assert.equal(unchanged.publishProduction, false);
	assert.equal(unchanged.publishBeta, true);
	assert.throws(
		() => createReleasePlan({ eventName: "push", sha: "new", version: "0.7.2", previousVersion: "0.7.3" }),
		/newer than/i,
	);
	assert.throws(
		() =>
			createReleasePlan({
				eventName: "push",
				sha: "new",
				version: "0.7.2",
				previousVersion: "0.7.1",
				tagTarget: "other",
			}),
		/points to other, not new/i,
	);
});

test("trusted maintainer release comments are bound to default-branch workflow code", () => {
	assert.deepEqual(
		parseReleaseComment({
			actorPermission: "maintain",
			body: "/prime-agent release retry v0.7.2",
			defaultBranch: "main",
			expectedOperation: "retry-production",
			workflowRef: "PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/main",
		}),
		{ operation: "retry-production", releaseTag: "v0.7.2" },
	);
	assert.deepEqual(
		parseReleaseComment({
			actorPermission: "admin",
			body: "/prime-agent release rollback v0.7.1\nROLLBACK v0.7.1",
			defaultBranch: "main",
			expectedOperation: "rollback-production",
			workflowRef: "PrimeIntellect-ai/prime-agent/.github/workflows/rollback-release.yml@refs/heads/main",
		}),
		{ confirmation: "ROLLBACK v0.7.1", operation: "rollback-production", releaseTag: "v0.7.1" },
	);
	assert.throws(
		() =>
			parseReleaseComment({
				actorPermission: "write",
				body: "/prime-agent release retry v0.7.2",
				defaultBranch: "main",
				expectedOperation: "retry-production",
				workflowRef: "PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/main",
			}),
		/admin or maintain/i,
	);
	assert.throws(
		() =>
			parseReleaseComment({
				actorPermission: "admin",
				body: "/prime-agent release retry v0.7.2",
				defaultBranch: "main",
				expectedOperation: "retry-production",
				workflowRef: "PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/feature",
			}),
		/protected default branch/i,
	);
});

test("comment-requested production retry is bound to an existing tag and its immutable commit", () => {
	assert.deepEqual(
		createReleasePlan({
			eventName: "issue_comment",
			operation: "retry-production",
			releaseTag: "v0.7.2",
			version: "0.7.2",
			tagTarget: "feedface",
			tagOnDefaultBranch: true,
		}),
		{
			betaVersion: "",
			buildRef: "feedface",
			productionVersion: "0.7.2",
			publishBeta: false,
			publishProduction: true,
		},
	);
	assert.throws(
		() =>
			createReleasePlan({
				eventName: "issue_comment",
				operation: "retry-production",
				releaseTag: "v0.7.2",
				version: "0.7.2",
			}),
		/tag v0\.7\.2 does not exist/i,
	);
	assert.throws(
		() =>
			createReleasePlan({
				eventName: "issue_comment",
				operation: "retry-production",
				releaseTag: "v0.7.2",
				version: "0.7.2",
				tagTarget: "feedface",
				tagOnDefaultBranch: false,
			}),
		/default branch/i,
	);
});

test("immutable objects are created once, reused when identical, and never overwritten", () => {
	assert.equal(decideImmutableWrite("abc", undefined), "create");
	assert.equal(decideImmutableWrite("abc", "abc"), "reuse");
	assert.throws(() => decideImmutableWrite("abc", "def"), /immutable object differs/i);
});

test("channel manifests are commit markers written after legacy text pointers", () => {
	assert.deepEqual(promotionKeys("stable"), ["stable", "latest.json"]);
	assert.deepEqual(promotionKeys("beta"), ["beta", "beta.json"]);
});

test("rollback requires exact confirmation and remains pointer-only", () => {
	assert.deepEqual(validateRollbackRequest("v0.7.1", "ROLLBACK v0.7.1"), {
		manifestKey: "latest.json",
		pointerKey: "stable",
		version: "0.7.1",
	});
	assert.throws(() => validateRollbackRequest("v0.7.1", "v0.7.1"), /ROLLBACK v0\.7\.1/);
	assert.throws(() => validateRollbackRequest("beta", "ROLLBACK beta"), /plain stable release tag/i);
});

test("artifact verification checks branded manifests, internal URLs, and every checksum", () => {
	const { artifactsDir, root } = createArtifactFixture();
	try {
		const result = verifyReleaseArtifacts(artifactsDir, {
			baseUrl: "https://release.invalid",
			channel: "stable",
			sourceSha,
			version: "0.7.2",
		});
		assert.equal(result.tarballs.length, 4);
		writeFileSync(join(artifactsDir, "prime-agent-0.7.2.tgz"), "corrupt");
		assert.throws(
			() =>
				verifyReleaseArtifacts(artifactsDir, {
					baseUrl: "https://release.invalid",
					channel: "stable",
					sourceSha,
					version: "0.7.2",
				}),
			/checksum mismatch/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("artifact verification accepts only workflow-shaped beta versions", () => {
	const { artifactsDir, root } = createArtifactFixture("0.7.2-beta.42.1.0123456", "beta");
	try {
		assert.equal(
			verifyReleaseArtifacts(artifactsDir, {
				baseUrl: "https://release.invalid",
				channel: "beta",
				sourceSha,
				version: "0.7.2-beta.42.1.0123456",
			}).version,
			"v0.7.2-beta.42.1.0123456",
		);
		assert.throws(
			() =>
				verifyReleaseArtifacts(artifactsDir, {
					baseUrl: "https://release.invalid",
					channel: "beta",
					sourceSha,
					version: "0.7.2-custom",
				}),
			/workflow beta version/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("artifact verification rejects a packed CLI missing required internal R2 dependencies", () => {
	const { artifactsDir, root } = createArtifactFixture("0.7.2", "stable", {
		omitCliInternalDependencies: true,
	});
	try {
		assert.throws(
			() =>
				verifyReleaseArtifacts(artifactsDir, {
					baseUrl: "https://release.invalid",
					channel: "stable",
					sourceSha,
					version: "0.7.2",
				}),
			/missing the required internal dependency/i,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy release assets remain verifiable for retry and rollback without provenance", () => {
	const { artifactsDir, root } = createArtifactFixture();
	try {
		rmSync(join(artifactsDir, "release-provenance.json"));
		assert.throws(
			() =>
				verifyReleaseArtifacts(artifactsDir, {
					baseUrl: "https://release.invalid",
					channel: "stable",
					sourceSha,
					version: "0.7.2",
				}),
			/release-provenance\.json/,
		);
		assert.doesNotThrow(() =>
			verifyReleaseArtifacts(artifactsDir, {
				allowMissingProvenance: true,
				baseUrl: "https://release.invalid",
				channel: "stable",
				sourceSha,
				version: "0.7.2",
			}),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("current dry-run tooling validates a pre-migration source tree without release scripts", () => {
	const sourceRoot = createRepositoryFixture("0.7.1");
	const { artifactsDir, root: artifactRoot } = createArtifactFixture("0.7.1", "stable");
	const runDryRun = () =>
		spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("release-dry-run.mjs", import.meta.url)),
				"--channel",
				"stable",
				"--version",
				"0.7.1",
				"--base-url",
				"https://release.invalid",
				"--source-sha",
				sourceSha,
				"--artifacts-dir",
				artifactsDir,
			],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				encoding: "utf8",
				env: {
					...process.env,
					AWS_ACCESS_KEY_ID: "must-not-be-used",
					GH_TOKEN: "must-not-be-used",
					PRIME_AGENT_RELEASE_SOURCE_ROOT: sourceRoot,
					R2_BUCKET: "must-not-be-used",
				},
			},
		);
	try {
		assert.equal(JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).scripts, undefined);
		const result = runDryRun();
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Validated v0\.7\.1 stable artifacts without publishing/);

		const agentPath = join(sourceRoot, "packages/agent/package.json");
		const agent = JSON.parse(readFileSync(agentPath, "utf8"));
		agent.version = "0.7.0";
		writeJson(agentPath, agent);
		const drift = runDryRun();
		assert.equal(drift.status, 1);
		assert.match(drift.stderr, /packages\/agent version is 0\.7\.0; expected 0\.7\.1/);
	} finally {
		rmSync(artifactRoot, { recursive: true, force: true });
		rmSync(sourceRoot, { recursive: true, force: true });
	}
});
