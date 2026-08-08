import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	constants as fsConstants,
	copyFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const RELEASE_PACKAGES = [
	{ dir: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ dir: "packages/ai", name: "@earendil-works/pi-ai" },
	{ dir: "packages/coding-agent", name: "@earendil-works/pi-coding-agent" },
	{ dir: "packages/tui", name: "@earendil-works/pi-tui" },
];

export const RELEASE_PACKAGE_DIRS = RELEASE_PACKAGES.map((releasePackage) => releasePackage.dir);

const INTERNAL_PACKAGE_NAMES = new Set(RELEASE_PACKAGES.map((releasePackage) => releasePackage.name));
const EXPECTED_INTERNAL_DEPENDENCIES = new Map([
	["package.json", ["@earendil-works/pi-coding-agent"]],
	["packages/agent/package.json", ["@earendil-works/pi-ai"]],
	["packages/ai/package.json", []],
	[
		"packages/coding-agent/package.json",
		["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"],
	],
	["packages/tui/package.json", []],
]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BETA_VERSION_PATTERN = /^0\.\d+\.\d+-beta\.\d+\.\d+\.[0-9a-f]{7}$/;
export const RELEASE_ARTIFACTS = [
	{ filePrefix: "prime-agent-ai", packageName: "prime-agent-ai", sourceName: "@earendil-works/pi-ai" },
	{ filePrefix: "prime-agent-core", packageName: "prime-agent-core", sourceName: "@earendil-works/pi-agent-core" },
	{ filePrefix: "prime-agent-tui", packageName: "prime-agent-tui", sourceName: "@earendil-works/pi-tui" },
	{ filePrefix: "prime-agent", packageName: "prime-agent", sourceName: "@earendil-works/pi-coding-agent" },
];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function formatJson(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function parseVersion(version, label = "release version") {
	if (typeof version !== "string") {
		throw new Error(`${label} must be a plain semantic version`);
	}
	const match = version.match(VERSION_PATTERN);
	if (!match) {
		throw new Error(`${label} must be a plain semantic version like 0.7.2: ${version}`);
	}
	const parsed = {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		version,
	};
	if (parsed.major !== 0) {
		throw new Error(`${label} major version must remain 0: ${version}`);
	}
	return parsed;
}

export function compareVersions(leftVersion, rightVersion) {
	const left = parseVersion(leftVersion, "candidate version");
	const right = parseVersion(rightVersion, "current version");
	return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function bumpVersion(currentVersion, target) {
	const current = parseVersion(currentVersion, "current version");
	if (target === "major") {
		throw new Error("Major releases are not supported; use patch or minor");
	}
	if (target === "patch") {
		return `${current.major}.${current.minor}.${current.patch + 1}`;
	}
	if (target === "minor") {
		return `${current.major}.${current.minor + 1}.0`;
	}
	const explicit = parseVersion(target, "release version");
	if (compareVersions(explicit.version, current.version) <= 0) {
		throw new Error(`Release version ${explicit.version} must be newer than ${current.version}`);
	}
	return explicit.version;
}

function expectedRange(version) {
	return `^${version}`;
}

function validateInternalRanges(label, packageJson, version, errors, expectedPackagePath = label) {
	for (const name of EXPECTED_INTERNAL_DEPENDENCIES.get(expectedPackagePath) ?? []) {
		const range = packageJson.dependencies?.[name];
		if (range !== expectedRange(version)) {
			errors.push(`${label} dependencies.${name} is ${range ?? "missing"}; expected ${expectedRange(version)}`);
		}
	}
	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		for (const [name, range] of Object.entries(packageJson[field] ?? {})) {
			if (INTERNAL_PACKAGE_NAMES.has(name) && range !== expectedRange(version)) {
				errors.push(`${label} ${field}.${name} is ${range}; expected ${expectedRange(version)}`);
			}
		}
	}
}

function validateChangelog(root, packageDir, version, errors) {
	const path = join(root, packageDir, "CHANGELOG.md");
	if (!existsSync(path)) {
		errors.push(`${packageDir}/CHANGELOG.md is missing`);
		return;
	}
	const escapedVersion = version.replaceAll(".", "\\.");
	if (!new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(readFileSync(path, "utf8"))) {
		errors.push(`${packageDir}/CHANGELOG.md has no dated [${version}] release section`);
	}
}

export function validateReleaseRepository(root, options = {}) {
	const rootPackage = readJson(join(root, "package.json"));
	const version = options.version ?? rootPackage.version;
	parseVersion(version);
	const errors = [];
	if (rootPackage.version !== version) {
		errors.push(`package.json version is ${rootPackage.version}; expected ${version}`);
	}
	validateInternalRanges("package.json", rootPackage, version, errors);

	const lockPath = join(root, "package-lock.json");
	const lock = readJson(lockPath);
	if (lock.version !== version) {
		errors.push(`package-lock.json version is ${lock.version}; expected ${version}`);
	}
	const lockRoot = lock.packages?.[""];
	if (!lockRoot) {
		errors.push("package-lock.json is missing its root package metadata");
	} else {
		if (lockRoot.version !== version) {
			errors.push(`package-lock.json root package version is ${lockRoot.version}; expected ${version}`);
		}
		validateInternalRanges("package-lock.json root package", lockRoot, version, errors, "package.json");
	}

	for (const releasePackage of RELEASE_PACKAGES) {
		const packagePath = `${releasePackage.dir}/package.json`;
		const packageJson = readJson(join(root, packagePath));
		if (packageJson.name !== releasePackage.name) {
			errors.push(`${packagePath} name is ${packageJson.name}; expected ${releasePackage.name}`);
		}
		if (packageJson.version !== version) {
			errors.push(`${releasePackage.dir} version is ${packageJson.version}; expected ${version}`);
		}
		validateInternalRanges(packagePath, packageJson, version, errors);

		const lockPackage = lock.packages?.[releasePackage.dir];
		if (!lockPackage) {
			errors.push(`package-lock.json is missing ${releasePackage.dir}`);
		} else {
			if (lockPackage.version !== version) {
				errors.push(`package-lock.json ${releasePackage.dir} version is ${lockPackage.version}; expected ${version}`);
			}
			validateInternalRanges(
				`package-lock.json ${releasePackage.dir}`,
				lockPackage,
				version,
				errors,
				`${releasePackage.dir}/package.json`,
			);
		}

		if (options.requireChangelogs) {
			validateChangelog(root, releasePackage.dir, version, errors);
		}
	}

	if (errors.length > 0) {
		throw new Error(`Release metadata is inconsistent:\n- ${errors.join("\n- ")}`);
	}
	return { version };
}

function updateInternalRanges(packageJson, version) {
	for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
		if (!packageJson[field]) continue;
		for (const name of Object.keys(packageJson[field])) {
			if (INTERNAL_PACKAGE_NAMES.has(name)) {
				packageJson[field][name] = expectedRange(version);
			}
		}
	}
}

function releaseChangelog(content, version, date, path) {
	if (!/^## \[Unreleased\]$/m.test(content)) {
		throw new Error(`${path} has no [Unreleased] section`);
	}
	if (new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\](?: - |$)`, "m").test(content)) {
		throw new Error(`${path} already contains release ${version}`);
	}
	return content.replace(/^## \[Unreleased\]\n/m, `## [Unreleased]\n\n## [${version}] - ${date}\n`);
}

function writePreparedFiles(root, files, options = {}) {
	const staged = [];
	const replaced = [];
	const replaceFile = options.replaceFile ?? renameSync;
	let preserveBackups = false;
	try {
		for (const [index, [relativePath, content]] of files.entries()) {
			const path = join(root, relativePath);
			const temporaryPath = join(dirname(path), `.${basename(path)}.release-${process.pid}-${index}.tmp`);
			const backupPath = join(dirname(path), `.${basename(path)}.release-${process.pid}-${index}.backup`);
			writeFileSync(temporaryPath, content, { flag: "wx" });
			staged.push({ backupPath, path, temporaryPath });
			copyFileSync(path, backupPath, fsConstants.COPYFILE_EXCL);
		}
		for (const file of staged) {
			replaceFile(file.temporaryPath, file.path);
			replaced.push(file);
		}
		options.validate?.();
	} catch (error) {
		const rollbackErrors = [];
		for (const file of replaced.reverse()) {
			try {
				renameSync(file.backupPath, file.path);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
		}
		if (rollbackErrors.length > 0) {
			preserveBackups = true;
			throw new AggregateError([error, ...rollbackErrors], "Release preparation failed and could not be fully restored");
		}
		throw error;
	} finally {
		for (const file of staged) {
			rmSync(file.temporaryPath, { force: true });
			if (!preserveBackups) rmSync(file.backupPath, { force: true });
		}
	}
}

export function prepareRelease(root, target, options = {}) {
	const date = options.date ?? new Date().toISOString().slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`Release date must use YYYY-MM-DD: ${date}`);
	}
	const rootPackage = readJson(join(root, "package.json"));
	validateReleaseRepository(root, { version: rootPackage.version });
	const version = bumpVersion(rootPackage.version, target);
	const files = new Map();
	rootPackage.version = version;
	updateInternalRanges(rootPackage, version);
	files.set("package.json", formatJson(rootPackage));

	for (const releasePackage of RELEASE_PACKAGES) {
		const packagePath = `${releasePackage.dir}/package.json`;
		const packageJson = readJson(join(root, packagePath));
		packageJson.version = version;
		updateInternalRanges(packageJson, version);
		files.set(packagePath, formatJson(packageJson));

		const changelogPath = `${releasePackage.dir}/CHANGELOG.md`;
		const changelog = readFileSync(join(root, changelogPath), "utf8");
		files.set(changelogPath, releaseChangelog(changelog, version, date, changelogPath));
	}

	const lock = readJson(join(root, "package-lock.json"));
	lock.version = version;
	lock.packages[""].version = version;
	updateInternalRanges(lock.packages[""], version);
	for (const releasePackage of RELEASE_PACKAGES) {
		const lockPackage = lock.packages[releasePackage.dir];
		lockPackage.version = version;
		updateInternalRanges(lockPackage, version);
	}
	files.set("package-lock.json", formatJson(lock));

	writePreparedFiles(root, [...files.entries()], {
		replaceFile: options.replaceFile,
		validate: () => validateReleaseRepository(root, { version, requireChangelogs: true }),
	});
	return [...files.keys()].map((path) => relative(root, join(root, path)));
}

export function createReleasePlan(input) {
	const version = parseVersion(input.version).version;
	if (input.eventName === "push") {
		const publishProduction =
			input.previousVersion !== undefined && compareVersions(version, input.previousVersion) !== 0;
		if (publishProduction && compareVersions(version, input.previousVersion) <= 0) {
			throw new Error(`Production version ${version} must be newer than ${input.previousVersion}`);
		}
		if (publishProduction && input.tagTarget && input.tagTarget !== input.sha) {
			throw new Error(`Production tag v${version} points to ${input.tagTarget}, not ${input.sha}`);
		}
		const runNumber = input.runNumber ?? "0";
		const runAttempt = input.runAttempt ?? "0";
		return {
			betaVersion: `${version}-beta.${runNumber}.${runAttempt}.${input.sha.slice(0, 7)}`,
			buildRef: input.sha,
			productionVersion: publishProduction ? version : "",
			publishBeta: true,
			publishProduction,
		};
	}

	if (input.eventName === "issue_comment" && input.operation === "retry-production") {
		const expectedTag = `v${version}`;
		if (input.releaseTag !== expectedTag) {
			throw new Error(`Retry tag ${input.releaseTag ?? ""} does not match package version ${expectedTag}`);
		}
		if (!input.tagTarget) {
			throw new Error(`Retry tag ${expectedTag} does not exist`);
		}
		if (!input.tagOnDefaultBranch) {
			throw new Error(`Retry tag ${expectedTag} is not on the default branch`);
		}
		return {
			betaVersion: "",
			buildRef: input.tagTarget,
			productionVersion: version,
			publishBeta: false,
			publishProduction: true,
		};
	}

	throw new Error(`Unsupported release event or operation: ${input.eventName}/${input.operation ?? ""}`);
}

export function decideImmutableWrite(localSha256, remoteSha256) {
	if (!remoteSha256) return "create";
	if (localSha256 === remoteSha256) return "reuse";
	throw new Error(`Existing immutable object differs: local ${localSha256}, remote ${remoteSha256}`);
}

export function promotionKeys(channel) {
	if (channel === "stable") return ["stable", "latest.json"];
	if (channel === "beta") return ["beta", "beta.json"];
	throw new Error(`Unsupported release channel: ${channel}`);
}

export function validateRollbackRequest(releaseTag, confirmation) {
	if (!/^v0\.\d+\.\d+$/.test(releaseTag)) {
		throw new Error(`Rollback target must be a plain stable release tag like v0.7.1: ${releaseTag}`);
	}
	const expectedConfirmation = `ROLLBACK ${releaseTag}`;
	if (confirmation !== expectedConfirmation) {
		throw new Error(`Rollback confirmation must be exactly: ${expectedConfirmation}`);
	}
	return {
		manifestKey: "latest.json",
		pointerKey: "stable",
		version: releaseTag.slice(1),
	};
}

export function validateAuthorizedRollbackTarget(releaseTag, expectedSha, currentSha) {
	if (!/^[0-9a-f]{40}$/.test(expectedSha) || !/^[0-9a-f]{40}$/.test(currentSha)) {
		throw new Error(`Rollback tag ${releaseTag} must resolve to full commit SHAs`);
	}
	if (currentSha !== expectedSha) {
		throw new Error(`Rollback tag ${releaseTag} moved from authorized commit ${expectedSha} to ${currentSha}`);
	}
	return currentSha;
}

export function parseReleaseComment(input) {
	if (input.actorPermission !== "admin" && input.actorPermission !== "maintain") {
		throw new Error("Release commands require repository admin or maintain permission");
	}
	const trustedRefSuffix = `@refs/heads/${input.defaultBranch}`;
	if (!input.workflowRef?.endsWith(trustedRefSuffix)) {
		throw new Error(`Release commands must use workflow code from the protected default branch (${input.defaultBranch})`);
	}
	const body = input.body?.trim() ?? "";
	if (input.expectedOperation === "retry-production") {
		const match = body.match(/^\/prime-agent release retry (v0\.\d+\.\d+)$/);
		if (!match) throw new Error("Retry command must be exactly: /prime-agent release retry v0.x.y");
		return { operation: "retry-production", releaseTag: match[1] };
	}
	if (input.expectedOperation === "rollback-production") {
		const match = body.match(/^\/prime-agent release rollback (v0\.\d+\.\d+)\nROLLBACK (v0\.\d+\.\d+)$/);
		if (!match || match[1] !== match[2]) {
			throw new Error("Rollback command must use matching tags on both lines");
		}
		return {
			confirmation: `ROLLBACK ${match[1]}`,
			operation: "rollback-production",
			releaseTag: match[1],
		};
	}
	throw new Error(`Unsupported release command operation: ${input.expectedOperation ?? ""}`);
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function parseChecksums(content) {
	const checksums = new Map();
	for (const line of content.trim().split("\n")) {
		const match = line.match(/^([0-9a-f]{64})  ([^/]+)$/);
		if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
		if (checksums.has(match[2])) throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
		checksums.set(match[2], match[1]);
	}
	return checksums;
}

function readPackedPackageJson(tarballPath) {
	const result = spawnSync("tar", ["-xOf", tarballPath, "package/package.json"], {
		encoding: "utf8",
		stdio: "pipe",
	});
	if (result.status !== 0) {
		throw new Error(`Unable to read package/package.json from ${tarballPath}: ${result.stderr.trim()}`);
	}
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`Invalid packed package.json in ${tarballPath}: ${String(error)}`);
	}
}

function validatePackedPackage(packageJson, artifact, version, baseUrl, artifactFiles) {
	if (packageJson.name !== artifact.packageName) {
		throw new Error(`${artifact.file} package name is ${packageJson.name}; expected ${artifact.packageName}`);
	}
	if (packageJson.version !== version) {
		throw new Error(`${artifact.file} package version is ${packageJson.version}; expected ${version}`);
	}
	for (const forbiddenField of ["devDependencies", "overrides", "private"]) {
		if (forbiddenField in packageJson) {
			throw new Error(`${artifact.file} must not contain ${forbiddenField}`);
		}
	}
	for (const field of ["dependencies", "optionalDependencies"]) {
		for (const [name, range] of Object.entries(packageJson[field] ?? {})) {
			const internalArtifact = RELEASE_ARTIFACTS.find((candidate) => candidate.sourceName === name);
			if (!internalArtifact || internalArtifact.packageName === "prime-agent") continue;
			const expectedUrl = `${baseUrl}/releases/v${version}/${artifactFiles.get(internalArtifact.packageName)}`;
			if (range !== expectedUrl) {
				throw new Error(`${artifact.file} ${field}.${name} is ${range}; expected ${expectedUrl}`);
			}
		}
	}
	const expectedInternalDependencies =
		artifact.packageName === "prime-agent-core"
			? ["@earendil-works/pi-ai"]
			: artifact.packageName === "prime-agent"
				? ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]
				: [];
	for (const name of expectedInternalDependencies) {
		const internalArtifact = RELEASE_ARTIFACTS.find((candidate) => candidate.sourceName === name);
		const expectedUrl = `${baseUrl}/releases/v${version}/${artifactFiles.get(internalArtifact.packageName)}`;
		if (packageJson.dependencies?.[name] !== expectedUrl) {
			throw new Error(`${artifact.file} is missing the required internal dependency ${name}`);
		}
	}
	if (artifact.packageName === "prime-agent") {
		if (packageJson.bin?.["prime-agent"] !== "dist/bundle/cli.js") {
			throw new Error(`${artifact.file} does not expose the prime-agent executable`);
		}
		if (packageJson.piConfig?.name !== "prime-agent" || packageJson.piConfig?.configDir !== ".prime/agent") {
			throw new Error(`${artifact.file} has invalid Prime Agent package configuration`);
		}
	}
}

export function verifyReleaseArtifacts(artifactsDir, options) {
	const version = options.version;
	if (!/^[0-9a-f]{40}$/.test(options.sourceSha ?? "")) {
		throw new Error(`Artifact source SHA must be a full 40-character commit SHA: ${options.sourceSha ?? ""}`);
	}
	if (options.channel !== "stable" && options.channel !== "beta") {
		throw new Error(`Artifact channel must be stable or beta: ${options.channel}`);
	}
	if (options.channel === "stable") {
		parseVersion(version, "artifact version");
	} else if (!BETA_VERSION_PATTERN.test(version)) {
		throw new Error(`Artifact version must be a workflow beta version: ${version}`);
	}
	const baseUrl = options.baseUrl?.replace(/\/+$/, "");
	if (!baseUrl) throw new Error("Artifact base URL is required");
	const manifestName = options.channel === "stable" ? "latest.json" : "beta.json";
	const artifactFiles = new Map(
		RELEASE_ARTIFACTS.map((artifact) => [artifact.packageName, `${artifact.filePrefix}-${version}.tgz`]),
	);
	const expectedFiles = [
		...artifactFiles.values(),
		"SHA256SUMS",
		options.channel,
		manifestName,
	];
	const provenancePath = join(artifactsDir, "release-provenance.json");
	const hasProvenance = existsSync(provenancePath);
	if (hasProvenance || !options.allowMissingProvenance) expectedFiles.push("release-provenance.json");
	expectedFiles.sort();
	assertSameFiles(readdirSync(artifactsDir).sort(), expectedFiles);

	const checksums = parseChecksums(readFileSync(join(artifactsDir, "SHA256SUMS"), "utf8"));
	if (checksums.size !== RELEASE_ARTIFACTS.length) {
		throw new Error(`SHA256SUMS has ${checksums.size} entries; expected ${RELEASE_ARTIFACTS.length}`);
	}
	const tarballs = [];
	for (const artifact of RELEASE_ARTIFACTS) {
		const releaseArtifact = { ...artifact, file: artifactFiles.get(artifact.packageName) };
		const artifactPath = join(artifactsDir, releaseArtifact.file);
		const actualSha256 = sha256File(artifactPath);
		if (checksums.get(releaseArtifact.file) !== actualSha256) {
			throw new Error(`${releaseArtifact.file} checksum mismatch`);
		}
		const packageJson = readPackedPackageJson(artifactPath);
		validatePackedPackage(packageJson, releaseArtifact, version, baseUrl, artifactFiles);
		tarballs.push({ file: releaseArtifact.file, package: releaseArtifact.packageName, sha256: actualSha256 });
	}
	tarballs.sort((left, right) => left.file.localeCompare(right.file));

	const pointer = readFileSync(join(artifactsDir, options.channel), "utf8");
	if (pointer !== `v${version}\n`) {
		throw new Error(`${options.channel} pointer must contain v${version}`);
	}
	const manifest = readJson(join(artifactsDir, manifestName));
	const expectedManifest = {
		version: `v${version}`,
		package: "prime-agent",
		tarball: `releases/v${version}/${artifactFiles.get("prime-agent")}`,
		tarballs,
	};
	if (!isDeepStrictEqual(manifest, expectedManifest)) {
		throw new Error(`${manifestName} does not match the verified release artifacts`);
	}
	const expectedProvenance = {
		version: `v${version}`,
		channel: options.channel,
		sourceSha: options.sourceSha,
		package: "prime-agent",
		tarball: `releases/v${version}/${artifactFiles.get("prime-agent")}`,
		tarballs,
	};
	if (hasProvenance && !isDeepStrictEqual(readJson(provenancePath), expectedProvenance)) {
		throw new Error("release-provenance.json does not match the verified source and release artifacts");
	}
	return expectedProvenance;
}

function assertSameFiles(actual, expected) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`Artifact directory contains ${actual.join(", ")}; expected ${expected.join(", ")}`);
	}
}
