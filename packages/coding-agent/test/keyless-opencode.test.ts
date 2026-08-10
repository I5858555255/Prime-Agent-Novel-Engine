import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

// OpenCode Zen free-tier models need no API key: the auth gate must treat them
// as configured even with an empty auth store.

describe("ModelRegistry keyless models", () => {
	let tempDir: string;
	let registry: ModelRegistry;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-keyless-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		registry = ModelRegistry.inMemory(AuthStorage.create(join(tempDir, "auth.json")));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("free opencode models are configured without any auth", () => {
		const model = getModel("opencode", "deepseek-v4-flash-free")!;
		expect(registry.hasConfiguredAuth(model)).toBe(true);
		expect(registry.getAvailable().some((m) => m.provider === "opencode" && m.id === "deepseek-v4-flash-free")).toBe(
			true,
		);
	});

	test("paid opencode models still require auth", () => {
		const model = getModel("opencode", "kimi-k2.6")!;
		expect(registry.hasConfiguredAuth(model)).toBe(false);
	});

	test("provider status reports opencode as configured", () => {
		expect(registry.getProviderAuthStatus("opencode").configured).toBe(true);
	});
});
