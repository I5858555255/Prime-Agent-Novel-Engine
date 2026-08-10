import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../../../src/core/model-registry.js";

function fakeCodexJwt(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64url");
	return `${Buffer.from("{}").toString("base64url")}.${payload}.sig`;
}

function catalogResponse(slugs: string[]): Response {
	return new Response(JSON.stringify({ models: slugs.map((slug) => ({ slug })) }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("issue #696 empty codex catalog must not disable the provider", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-696-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
		vi.unstubAllGlobals();
	});

	it("keeps codex models executable when discovery succeeds with zero models", async () => {
		const registry = ModelRegistry.inMemory(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", fakeCodexJwt("acct_696"));
		const available = registry.getAvailable().filter((model) => model.provider === "openai-codex");
		expect(available.length).toBeGreaterThan(0);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([])),
		);

		const executable = await registry.getExecutableModels();
		const codex = executable.filter((model) => model.provider === "openai-codex");
		expect(codex.length).toBe(available.length);
	});

	it("keeps codex models executable from a cached empty catalog", async () => {
		const registry = ModelRegistry.inMemory(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", fakeCodexJwt("acct_696_cached"));
		const fetchMock = vi.fn(async () => catalogResponse([]));
		vi.stubGlobal("fetch", fetchMock);

		await registry.getExecutableModels();
		const secondPass = await registry.getExecutableModels();
		const codex = secondPass.filter((model) => model.provider === "openai-codex");
		expect(codex.length).toBeGreaterThan(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("still filters to the catalog when discovery returns a subset", async () => {
		const registry = ModelRegistry.inMemory(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", fakeCodexJwt("acct_696_subset"));
		const available = registry.getAvailable().filter((model) => model.provider === "openai-codex");
		expect(available.length).toBeGreaterThan(1);
		const keep = available[0]!.id;

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([keep])),
		);

		const executable = await registry.getExecutableModels();
		const codex = executable.filter((model) => model.provider === "openai-codex");
		expect(codex.map((model) => model.id)).toEqual([keep]);
	});
});
