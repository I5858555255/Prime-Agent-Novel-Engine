import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	promoteChannel,
	publishChannel,
	publishImmutableArtifacts,
	publishInstallers,
	verifyRemoteRelease,
} from "./lib/release-publication.mjs";

class MemoryStore {
	constructor(initial = {}) {
		this.events = [];
		this.objects = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
	}

	read(key) {
		this.events.push(`read:${key}`);
		return this.objects.get(key);
	}

	putImmutable(key, path) {
		this.events.push(`immutable:${key}`);
		if (this.objects.has(key)) return false;
		this.objects.set(key, readFileSync(path));
		return true;
	}

	putMutable(key, path) {
		this.events.push(`mutable:${key}`);
		this.objects.set(key, readFileSync(path));
	}
}

function createPublicationFixture(version = "0.7.2", channel = "stable") {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-publication-test-"));
	const artifactsDir = join(root, "artifacts");
	mkdirSync(artifactsDir);
	writeFileSync(join(artifactsDir, `prime-agent-${version}.tgz`), "cli");
	writeFileSync(join(artifactsDir, "SHA256SUMS"), "checksums");
	writeFileSync(join(artifactsDir, channel), `v${version}\n`);
	const manifestName = channel === "stable" ? "latest.json" : "beta.json";
	writeFileSync(
		join(artifactsDir, manifestName),
		`${JSON.stringify({
			version: `v${version}`,
			package: "prime-agent",
			tarball: `releases/v${version}/prime-agent-${version}.tgz`,
			tarballs: [],
		})}\n`,
	);
	return { artifactsDir, manifestName, root };
}

test("immutable publication creates missing objects, reuses identical objects, and rejects drift", () => {
	const { artifactsDir, root } = createPublicationFixture();
	const store = new MemoryStore();
	try {
		const first = publishImmutableArtifacts(artifactsDir, "0.7.2", store);
		assert.equal(first.created, 4);
		assert.equal(first.reused, 0);
		const second = publishImmutableArtifacts(artifactsDir, "0.7.2", store);
		assert.equal(second.created, 0);
		assert.equal(second.reused, 4);
		writeFileSync(join(artifactsDir, "prime-agent-0.7.2.tgz"), "different");
		assert.throws(() => publishImmutableArtifacts(artifactsDir, "0.7.2", store), /immutable object differs/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("immutable publication rejects a conflicting object created by a concurrent publisher", () => {
	const { artifactsDir, root } = createPublicationFixture();
	const store = new MemoryStore();
	store.putImmutable = (key) => {
		store.events.push(`immutable-race:${key}`);
		store.objects.set(key, Buffer.from("conflicting concurrent bytes"));
		return false;
	};
	try {
		assert.throws(() => publishImmutableArtifacts(artifactsDir, "0.7.2", store), /remote release object differs/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("channel transaction completes the mirror before pointer and manifest promotion", () => {
	const { artifactsDir, root } = createPublicationFixture();
	const store = new MemoryStore();
	try {
		publishChannel({
			artifactsDir,
			channel: "stable",
			mirror: () => store.events.push("mirror"),
			store,
			version: "0.7.2",
		});
		assert.ok(store.events.indexOf("mirror") > store.events.findIndex((event) => event.startsWith("immutable:")));
		assert.ok(store.events.indexOf("mirror") < store.events.indexOf("mutable:stable"));
		assert.ok(store.events.indexOf("mutable:stable") < store.events.indexOf("mutable:latest.json"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("beta publication rechecks freshness before every mutable phase", () => {
	const { artifactsDir, root } = createPublicationFixture("0.7.2-beta.42.1.0123456", "beta");
	const installerPath = join(root, "install-beta.sh");
	writeFileSync(installerPath, "installer");
	const store = new MemoryStore();
	try {
		publishChannel({
			artifactsDir,
			beforeMutable: (phase) => store.events.push(`guard:${phase}`),
			channel: "beta",
			installers: [{ key: "install-beta.sh", path: installerPath }],
			mirror: () => store.events.push("mirror"),
			store,
			version: "0.7.2-beta.42.1.0123456",
		});
		assert.notEqual(store.events.indexOf("guard:mirror"), -1);
		assert.notEqual(store.events.indexOf("guard:installers"), -1);
		assert.notEqual(store.events.indexOf("guard:promotion"), -1);
		assert.ok(store.events.indexOf("guard:mirror") < store.events.indexOf("mirror"));
		assert.ok(store.events.indexOf("guard:installers") < store.events.indexOf("mutable:install-beta.sh"));
		assert.ok(store.events.indexOf("guard:promotion") < store.events.indexOf("mutable:beta"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a beta that becomes stale during mutable work cannot advance channel pointers", () => {
	const { artifactsDir, root } = createPublicationFixture("0.7.2-beta.42.1.0123456", "beta");
	const installerPath = join(root, "install-beta.sh");
	writeFileSync(installerPath, "installer");
	const store = new MemoryStore();
	try {
		assert.throws(
			() =>
				publishChannel({
					artifactsDir,
					beforeMutable(phase) {
						store.events.push(`guard:${phase}`);
						if (phase === "installers") throw new Error("newer main commit");
					},
					channel: "beta",
					installers: [{ key: "install-beta.sh", path: installerPath }],
					mirror: () => store.events.push("mirror"),
					store,
					version: "0.7.2-beta.42.1.0123456",
				}),
			/newer main commit/,
		);
		assert.equal(store.objects.has("install-beta.sh"), false);
		assert.equal(store.objects.has("beta"), false);
		assert.equal(store.objects.has("beta.json"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("split beta mutation helpers run their freshness guard inside the write boundary", () => {
	const { artifactsDir, root } = createPublicationFixture("0.7.2-beta.42.1.0123456", "beta");
	const installerPath = join(root, "install-beta.sh");
	writeFileSync(installerPath, "installer");
	try {
		const installerStore = new MemoryStore();
		assert.throws(
			() =>
				publishInstallers([{ key: "install-beta.sh", path: installerPath }], installerStore, {
					beforeWrite: () => {
						throw new Error("newer main commit");
					},
				}),
			/newer main commit/,
		);
		assert.equal(installerStore.objects.has("install-beta.sh"), false);

		const promotionStore = new MemoryStore();
		assert.throws(
			() =>
				promoteChannel(artifactsDir, "beta", promotionStore, {
					beforeWrite: () => {
						throw new Error("newer main commit");
					},
				}),
			/newer main commit/,
		);
		assert.equal(promotionStore.objects.has("beta"), false);
		assert.equal(promotionStore.objects.has("beta.json"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stable promotion is monotonic unless an explicit rollback allows regression", () => {
	const { artifactsDir, root } = createPublicationFixture();
	const store = new MemoryStore({
		"latest.json": `${JSON.stringify({ version: "v0.7.3" })}\n`,
		stable: "v0.7.3\n",
	});
	try {
		assert.throws(() => promoteChannel(artifactsDir, "stable", store), /would regress.*0\.7\.3/i);
		promoteChannel(artifactsDir, "stable", store, { allowRegression: true });
		assert.equal(store.objects.get("stable").toString(), "v0.7.2\n");
		assert.match(store.objects.get("latest.json").toString(), /v0\.7\.2/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stable promotion uses the highest version across split pointer surfaces", () => {
	const { artifactsDir, root } = createPublicationFixture();
	try {
		const pointerAhead = new MemoryStore({
			"latest.json": readFileSync(join(artifactsDir, "latest.json")),
			stable: "v0.7.3\n",
		});
		assert.throws(() => promoteChannel(artifactsDir, "stable", pointerAhead), /stable.*0\.7\.3/i);

		const manifestAhead = new MemoryStore({
			"latest.json": `${JSON.stringify({ version: "v0.7.3" })}\n`,
			stable: "v0.7.1\n",
		});
		assert.throws(() => promoteChannel(artifactsDir, "stable", manifestAhead), /latest\.json.*0\.7\.3/i);

		const rollback = new MemoryStore({
			"latest.json": `${JSON.stringify({ version: "v0.7.3" })}\n`,
			stable: "v0.7.4\n",
		});
		promoteChannel(artifactsDir, "stable", rollback, { allowRegression: true });
		assert.equal(rollback.objects.get("stable").toString(), "v0.7.2\n");
		assert.match(rollback.objects.get("latest.json").toString(), /v0\.7\.2/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("remote verification proves every saved release object before rollback", () => {
	const { artifactsDir, root } = createPublicationFixture();
	const store = new MemoryStore();
	try {
		publishImmutableArtifacts(artifactsDir, "0.7.2", store);
		assert.equal(verifyRemoteRelease(artifactsDir, "0.7.2", store).verified, 4);
		store.objects.set("releases/v0.7.2/SHA256SUMS", Buffer.from("drift"));
		assert.throws(() => verifyRemoteRelease(artifactsDir, "0.7.2", store), /remote release object differs/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
