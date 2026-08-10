import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../../../src/core/model-registry.js";

function codexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function catalogResponse(slugs: string[]): Response {
	return new Response(JSON.stringify({ models: slugs.map((slug) => ({ slug })) }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("#696 empty Codex model discovery", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-696-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		clearApiKeyCache();
		vi.unstubAllGlobals();
	});

	it("keeps authenticated Codex models executable when discovery returns an empty catalog", async () => {
		const registry = ModelRegistry.inMemory(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", codexToken("account-empty"));
		const available = registry.getAvailable().filter((model) => model.provider === "openai-codex");
		expect(available.length).toBeGreaterThan(0);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([])),
		);

		const executable = (await registry.getExecutableModels()).filter((model) => model.provider === "openai-codex");

		expect(executable.map((model) => model.id)).toEqual(available.map((model) => model.id));
	});

	it("reuses a cached empty catalog without hiding Codex models", async () => {
		const registry = ModelRegistry.inMemory(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", codexToken("account-cached"));
		const fetchModels = vi.fn(async () => catalogResponse([]));
		vi.stubGlobal("fetch", fetchModels);

		await registry.getExecutableModels();
		const executable = (await registry.getExecutableModels()).filter((model) => model.provider === "openai-codex");

		expect(executable.length).toBeGreaterThan(0);
		expect(fetchModels).toHaveBeenCalledOnce();
	});

	it("keeps a non-empty account catalog authoritative", async () => {
		const registry = ModelRegistry.inMemory(authStorage);
		authStorage.setRuntimeApiKey("openai-codex", codexToken("account-subset"));
		const available = registry.getAvailable().filter((model) => model.provider === "openai-codex");
		expect(available.length).toBeGreaterThan(1);
		const selectedModel = available[0]!.id;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => catalogResponse([selectedModel])),
		);

		const executable = (await registry.getExecutableModels()).filter((model) => model.provider === "openai-codex");

		expect(executable.map((model) => model.id)).toEqual([selectedModel]);
	});
});
