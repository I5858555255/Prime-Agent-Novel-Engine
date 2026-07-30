import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const CACHE_FILE = "prime-inference-private-models.json";

interface TempRegistry {
	tempDir: string;
	cachePath: string;
	registry: ModelRegistry;
}

function fingerprint(apiKey: string, teamId: string): string {
	return createHash("sha256").update(apiKey).update("\0").update(teamId).digest("hex");
}

function createTempRegistry(authStorage: AuthStorage): TempRegistry {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-model-registry-cache-"));
	const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
	return { tempDir, cachePath: join(tempDir, CACHE_FILE), registry };
}

function primeAuth(teamId: string) {
	return AuthStorage.inMemory({
		"prime-inference": {
			type: "api_key",
			key: "prime-key",
			primeTeam: { teamId, name: "Team" },
		},
	});
}

function hasPrivateRoute(registry: ModelRegistry): boolean {
	return registry.getAvailable().some((model) => model.id === "internal/glm-5.2-fast");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("private Prime Inference authorization cache", () => {
	const tempDirs: string[] = [];
	let savedOffline: string | undefined;

	function track(dir: string): string {
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
		if (savedOffline === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = savedOffline;
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("cold start fetches and persists the authorization cache", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ data: [{ id: "internal/glm-5.2-fast" }] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { tempDir, cachePath, registry } = createTempRegistry(primeAuth("engineering-team"));
		track(tempDir);

		const models = await registry.refreshAvailableModels();

		expect(models.some((model) => model.id === "internal/glm-5.2-fast")).toBe(true);
		expect(fetchMock).toHaveBeenCalledOnce();
		const cache = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cache.fingerprint).toBe(fingerprint("prime-key", "engineering-team"));
		expect(cache.modelIds).toEqual(["internal/glm-5.2-fast"]);
		expect(typeof cache.refreshedAt).toBe("number");
	});

	test("a fresh cache serves authorization without touching the network", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be used");
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tempDir, cachePath, registry } = createTempRegistry(primeAuth("engineering-team"));
		track(tempDir);
		writeFileSync(
			cachePath,
			JSON.stringify({
				fingerprint: fingerprint("prime-key", "engineering-team"),
				modelIds: ["internal/glm-5.2-fast"],
				refreshedAt: Date.now(),
			}),
		);

		expect((await registry.refreshAvailableModels()).some((model) => model.id === "internal/glm-5.2-fast")).toBe(
			true,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("a stale cache serves the cached ids and refreshes in the background", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const { tempDir, cachePath, registry } = createTempRegistry(primeAuth("engineering-team"));
		track(tempDir);
		writeFileSync(
			cachePath,
			JSON.stringify({
				fingerprint: fingerprint("prime-key", "engineering-team"),
				modelIds: ["internal/glm-5.2-fast"],
				refreshedAt: Date.now() - 10 * 60_000,
			}),
		);

		const models = await registry.refreshAvailableModels();

		expect(models.some((model) => model.id === "internal/glm-5.2-fast")).toBe(true);
		await waitFor(() => fetchMock.mock.calls.length === 1);
		await waitFor(() => !hasPrivateRoute(registry));
		const cache = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cache.modelIds).toEqual([]);
	});

	test("a cache for different credentials is ignored", async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const { tempDir, cachePath, registry } = createTempRegistry(primeAuth("engineering-team"));
		track(tempDir);
		writeFileSync(
			cachePath,
			JSON.stringify({
				fingerprint: fingerprint("prime-key", "other-team"),
				modelIds: ["internal/glm-5.2-fast"],
				refreshedAt: Date.now(),
			}),
		);

		expect((await registry.refreshAvailableModels()).some((model) => model.id === "internal/glm-5.2-fast")).toBe(
			false,
		);
		expect(fetchMock).toHaveBeenCalledOnce();
		const cache = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cache.fingerprint).toBe(fingerprint("prime-key", "engineering-team"));
	});

	test("offline mode serves the cache without fetching", async () => {
		savedOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be used");
		});
		vi.stubGlobal("fetch", fetchMock);
		const { tempDir, cachePath, registry } = createTempRegistry(primeAuth("engineering-team"));
		track(tempDir);
		writeFileSync(
			cachePath,
			JSON.stringify({
				fingerprint: fingerprint("prime-key", "engineering-team"),
				modelIds: ["internal/glm-5.2-fast"],
				refreshedAt: Date.now() - 60 * 60_000,
			}),
		);

		expect((await registry.refreshAvailableModels()).some((model) => model.id === "internal/glm-5.2-fast")).toBe(
			true,
		);
		expect(fetchMock).not.toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
