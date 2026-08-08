import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compareVersions, decideImmutableWrite, promotionKeys } from "./release-lifecycle.mjs";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function requireRemoteMatch(store, key, local) {
	const remote = store.read(key);
	if (!remote) throw new Error(`Remote release object is missing after publication: ${key}`);
	if (sha256(local) !== sha256(remote)) {
		throw new Error(`Remote release object differs from the validated artifact: ${key}`);
	}
}

export function publishImmutableArtifacts(artifactsDir, version, store) {
	let created = 0;
	let reused = 0;
	for (const file of readdirSync(artifactsDir).sort()) {
		const path = join(artifactsDir, file);
		const key = `releases/v${version}/${file}`;
		const local = readFileSync(path);
		const remote = store.read(key);
		const decision = decideImmutableWrite(sha256(local), remote ? sha256(remote) : undefined);
		if (decision === "create") {
			const wasCreated = store.putImmutable(key, path, {
				cacheControl: "public, max-age=31536000, immutable",
				contentType: contentTypeFor(file),
			});
			if (wasCreated) created += 1;
			else reused += 1;
		} else {
			reused += 1;
		}
		requireRemoteMatch(store, key, local);
	}
	return { created, reused };
}

export function verifyRemoteRelease(artifactsDir, version, store, options = {}) {
	let verified = 0;
	const files = options.files ?? readdirSync(artifactsDir).sort();
	for (const file of files) {
		const key = `releases/v${version}/${file}`;
		requireRemoteMatch(store, key, readFileSync(join(artifactsDir, file)));
		verified += 1;
	}
	return { verified };
}

export function validatePromotion(artifactsDir, channel, store, options = {}) {
	const [pointerKey, manifestKey] = promotionKeys(channel);
	const manifestPath = join(artifactsDir, manifestKey);
	const manifest = readFileSync(manifestPath);
	const candidateVersion = JSON.parse(manifest).version.replace(/^v/, "");
	if (channel === "stable") {
		const currentPointer = store.read(pointerKey);
		const currentManifest = store.read(manifestKey);
		const currentSurfaces = [];
		if (currentPointer) {
			const pointerMatch = currentPointer.toString().match(/^v(0\.\d+\.\d+)\n$/);
			if (!pointerMatch) throw new Error(`${pointerKey} contains an invalid stable release pointer`);
			currentSurfaces.push({ key: pointerKey, version: pointerMatch[1] });
		}
		if (currentManifest) {
			const currentVersion = JSON.parse(currentManifest).version?.replace(/^v/, "");
			currentSurfaces.push({ key: manifestKey, version: currentVersion });
			if (compareVersions(candidateVersion, currentVersion) === 0 && sha256(currentManifest) !== sha256(manifest)) {
				throw new Error(`Stable manifest for ${candidateVersion} differs from the current manifest`);
			}
		}
		if (!options.allowRegression) {
			for (const current of currentSurfaces) {
				if (compareVersions(candidateVersion, current.version) < 0) {
					throw new Error(
						`Stable promotion to ${candidateVersion} would regress ${current.key} from ${current.version}`,
					);
				}
			}
		}
	}
	return { manifestKey, pointerKey };
}

export function promoteChannel(artifactsDir, channel, store, options = {}) {
	const { manifestKey, pointerKey } = validatePromotion(artifactsDir, channel, store, options);
	const pointerPath = join(artifactsDir, pointerKey);
	const manifestPath = join(artifactsDir, manifestKey);
	const pointer = readFileSync(pointerPath);
	const manifest = readFileSync(manifestPath);

	store.putMutable(pointerKey, pointerPath, { cacheControl: "no-cache", contentType: "text/plain" });
	requireRemoteMatch(store, pointerKey, pointer);
	store.putMutable(manifestKey, manifestPath, { cacheControl: "no-cache", contentType: "application/json" });
	requireRemoteMatch(store, manifestKey, manifest);
	return { manifestKey, pointerKey };
}

export function publishChannel(options) {
	const immutable = publishImmutableArtifacts(options.artifactsDir, options.version, options.store);
	options.beforeMutable?.("mirror");
	options.mirror?.();
	verifyRemoteRelease(options.artifactsDir, options.version, options.store);
	options.beforeMutable?.("installers");
	for (const installer of options.installers ?? []) {
		const local = readFileSync(installer.path);
		options.store.putMutable(installer.key, installer.path, {
			cacheControl: "no-cache",
			contentType: "text/x-shellscript",
		});
		requireRemoteMatch(options.store, installer.key, local);
	}
	options.beforeMutable?.("promotion");
	const promotion = promoteChannel(options.artifactsDir, options.channel, options.store, {
		allowRegression: options.allowRegression,
	});
	return { ...immutable, ...promotion };
}

function contentTypeFor(file) {
	if (file.endsWith(".tgz")) return "application/gzip";
	if (file.endsWith(".json")) return "application/json";
	return "text/plain";
}
