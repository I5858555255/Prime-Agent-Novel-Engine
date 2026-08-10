import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDaemonSupervisorOwnership } from "../../../src/modes/daemon/daemon-supervisor-ownership.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	// Ownership must be released (and its registry lock dropped) before the registry
	// directory is removed, otherwise the removal races the lockfile and throws ENOTEMPTY.
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

function registryDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-ownership-test-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

async function acquire(registry: string, generation: string, socketName = "daemon.sock") {
	const ownership = await acquireDaemonSupervisorOwnership({
		socketPath: join(registry, socketName),
		descriptorDir: join(registry, `descriptors-${generation}`),
		agentDir: join(registry, "agent"),
		generation,
		appVersion: "0.0.0-test",
		registryDir: registry,
	});
	cleanups.push(() => ownership.release().catch(() => undefined));
	return ownership;
}

function ownerDirectory(registry: string, generation: string): string {
	return resolve(registry, `${generation}.owner`);
}

describe("daemon supervisor ownership", () => {
	it("recovers when an external pruner deletes owner.json underneath a live supervisor", async () => {
		const registry = registryDir();
		const ownership = await acquire(registry, "gen-reaped");

		// macOS prunes /var/folders entries untouched for ~3 days, which deletes the record
		// of a healthy long-lived supervisor and leaves the owner directory behind empty.
		rmSync(resolve(ownerDirectory(registry, "gen-reaped"), "owner.json"), { force: true });
		rmSync(resolve(ownerDirectory(registry, "gen-reaped"), "scope.json"), { force: true });

		await expect(ownership.assertCurrent()).resolves.toBeUndefined();
		// The restored entry keeps working for every later command, not just the first.
		await expect(ownership.assertCurrent()).resolves.toBeUndefined();
	});

	it("recovers when the whole owner directory is pruned", async () => {
		const registry = registryDir();
		const ownership = await acquire(registry, "gen-dir-gone");

		rmSync(ownerDirectory(registry, "gen-dir-gone"), { recursive: true, force: true });

		await expect(ownership.assertCurrent()).resolves.toBeUndefined();
	});

	it("still reports lost ownership when another record replaced ours", async () => {
		const registry = registryDir();
		const ownership = await acquire(registry, "gen-replaced");

		writeFileSync(
			resolve(ownerDirectory(registry, "gen-replaced"), "owner.json"),
			JSON.stringify({ ...ownership.record, token: "a-different-token" }),
		);

		await expect(ownership.assertCurrent()).rejects.toMatchObject({
			code: "supervisor_generation_stale",
		});
	});

	it("still reports lost ownership when a live supervisor claimed our socket", async () => {
		const registry = registryDir();
		const ownership = await acquire(registry, "gen-superseded");
		rmSync(ownerDirectory(registry, "gen-superseded"), { recursive: true, force: true });

		// A different generation holding the same socket, whose pid is alive.
		const usurperDirectory = ownerDirectory(registry, "gen-usurper");
		mkdirSync(usurperDirectory, { recursive: true, mode: 0o700 });
		const { processStartId: _ignored, ...identity } = ownership.record;
		writeFileSync(
			resolve(usurperDirectory, "owner.json"),
			JSON.stringify({
				...identity,
				token: "usurper-token",
				generation: "gen-usurper",
				pid: process.pid,
			}),
		);

		await expect(ownership.assertCurrent()).rejects.toMatchObject({
			code: "supervisor_generation_stale",
		});
	});
});
