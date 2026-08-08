#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const commitShaPattern = /^[0-9a-f]{40}$/;
const releaseChannels = new Set(["stable", "beta"]);
const releasePackages = [
	{ filePrefix: "prime-agent", name: "prime-agent" },
	{ filePrefix: "prime-agent-ai", name: "prime-agent-ai" },
	{ filePrefix: "prime-agent-core", name: "prime-agent-core" },
	{ filePrefix: "prime-agent-tui", name: "prime-agent-tui" },
];

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function expectedTarballs(version) {
	return releasePackages
		.map((entry) => ({ ...entry, file: `${entry.filePrefix}-${version}.tgz` }))
		.sort((left, right) => left.file.localeCompare(right.file));
}

function readChecksums(path, expectedFiles) {
	const entries = new Map();
	for (const line of readFileSync(path, "utf8").trim().split("\n")) {
		const match = /^([0-9a-f]{64})  ([^/]+)$/.exec(line);
		if (!match) throw new Error(`Invalid checksum line in ${path}: ${line}`);
		const [, checksum, file] = match;
		if (basename(file) !== file) throw new Error(`Unsafe checksum filename: ${file}`);
		if (entries.has(file)) throw new Error(`Duplicate checksum entry: ${file}`);
		entries.set(file, checksum);
	}
	const actualFiles = [...entries.keys()].sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())) {
		throw new Error(`Checksum file set mismatch: ${actualFiles.join(", ")}`);
	}
	return entries;
}

function verifyManifest({ checksums, manifest, manifestName, sourceSha, tarballs, version }) {
	if (manifest.version !== `v${version}`) throw new Error(`${manifestName} version does not match v${version}`);
	if (manifest.sourceSha !== sourceSha) throw new Error(`${manifestName} source SHA does not match ${sourceSha}`);
	if (manifest.package !== "prime-agent") throw new Error(`${manifestName} package must be prime-agent`);
	if (manifest.tarball !== `releases/v${version}/prime-agent-${version}.tgz`) {
		throw new Error(`${manifestName} CLI tarball is invalid`);
	}
	if (!Array.isArray(manifest.tarballs) || manifest.tarballs.length !== tarballs.length) {
		throw new Error(`${manifestName} tarball list is incomplete`);
	}
	const actualManifestTarballs = [...manifest.tarballs].sort((left, right) => left.file.localeCompare(right.file));
	for (let index = 0; index < tarballs.length; index += 1) {
		const expected = tarballs[index];
		const actual = actualManifestTarballs[index];
		if (
			actual?.package !== expected.name ||
			actual.file !== expected.file ||
			actual.sha256 !== checksums.get(expected.file)
		) {
			throw new Error(`${manifestName} tarball metadata is invalid for ${expected.file}`);
		}
	}
}

export function verifyReleaseArtifacts({ channel, directory, remoteChecksums, remoteManifest, sourceSha, version }) {
	if (!releaseChannels.has(channel)) throw new Error(`Unsupported release channel: ${channel}`);
	if (!commitShaPattern.test(sourceSha)) throw new Error(`Invalid source SHA: ${sourceSha}`);
	if (!/^[0-9A-Za-z.-]+$/.test(version)) throw new Error(`Invalid release version: ${version}`);

	const tarballs = expectedTarballs(version);
	const expectedFiles = tarballs.map((entry) => entry.file);
	const checksumsPath = join(directory, "SHA256SUMS");
	const checksums = readChecksums(checksumsPath, expectedFiles);
	for (const tarball of tarballs) {
		const actual = sha256File(join(directory, tarball.file));
		if (checksums.get(tarball.file) !== actual) throw new Error(`Checksum mismatch: ${tarball.file}`);
	}

	if (remoteChecksums) {
		const remote = readChecksums(remoteChecksums, expectedFiles);
		for (const file of expectedFiles) {
			if (remote.get(file) !== checksums.get(file)) {
				throw new Error(`Immutable release hash drift: ${file}`);
			}
		}
	}

	const pointer = readFileSync(join(directory, channel), "utf8");
	if (pointer !== `v${version}\n`) throw new Error(`${channel} pointer does not match v${version}`);
	const manifestName = channel === "stable" ? "latest.json" : "beta.json";
	const manifestContent = readFileSync(join(directory, manifestName), "utf8");
	const manifest = JSON.parse(manifestContent);
	verifyManifest({ checksums, manifest, manifestName, sourceSha, tarballs, version });
	if (remoteManifest) {
		try {
			const remoteManifestContent = readFileSync(remoteManifest, "utf8");
			if (remoteManifestContent !== manifestContent) throw new Error("content does not match local manifest");
			verifyManifest({
				checksums,
				manifest: JSON.parse(remoteManifestContent),
				manifestName: "Remote immutable manifest",
				sourceSha,
				tarballs,
				version,
			});
		} catch (error) {
			throw new Error(`Immutable release manifest drift: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function parseArgs(args) {
	const parsed = {};
	const allowed = new Set(["channel", "directory", "remote_checksums", "remote_manifest", "source_sha", "version"]);
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument: ${name || "missing"}`);
		const key = name.slice(2).replaceAll("-", "_");
		if (!allowed.has(key)) throw new Error(`Unknown argument: ${name}`);
		if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate argument: ${name}`);
		parsed[key] = value;
	}
	return parsed;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	for (const required of ["channel", "directory", "source_sha", "version"]) {
		if (!args[required]) throw new Error(`--${required.replaceAll("_", "-")} is required`);
	}
	verifyReleaseArtifacts({
		channel: args.channel,
		directory: resolve(args.directory),
		remoteChecksums: args.remote_checksums ? resolve(args.remote_checksums) : undefined,
		remoteManifest: args.remote_manifest ? resolve(args.remote_manifest) : undefined,
		sourceSha: args.source_sha,
		version: args.version,
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
