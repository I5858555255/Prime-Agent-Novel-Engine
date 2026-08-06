import { Buffer } from "node:buffer";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

function codexAccessToken(accountId = "account-id"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function createCodexRegistry(access = codexAccessToken()): ModelRegistry {
	return ModelRegistry.inMemory(
		AuthStorage.inMemory({
			"openai-codex": {
				type: "oauth",
				access,
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		}),
	);
}

describe("ModelRegistry Codex catalog discovery", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("keeps authenticated Codex models executable when discovery returns an empty catalog", async () => {
		const registry = createCodexRegistry();
		const configuredCodexIds = registry
			.getAvailable()
			.filter((model) => model.provider === "openai-codex")
			.map((model) => model.id);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models: [] })));

		const executableCodexIds = (await registry.getExecutableModels())
			.filter((model) => model.provider === "openai-codex")
			.map((model) => model.id);

		expect(executableCodexIds).toEqual(configuredCodexIds);
	});

	test("uses a non-empty live Codex catalog to filter executable models", async () => {
		const registry = createCodexRegistry();
		const configuredCodex = registry.getAvailable().filter((model) => model.provider === "openai-codex");
		const allowedModel = configuredCodex[0]!;
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models: [{ slug: allowedModel.id }] })));

		const executableCodexIds = (await registry.getExecutableModels())
			.filter((model) => model.provider === "openai-codex")
			.map((model) => model.id);

		expect(executableCodexIds).toEqual([allowedModel.id]);
	});

	test("keeps authenticated Codex models executable when discovery fails without a cached catalog", async () => {
		const registry = createCodexRegistry();
		const configuredCodexIds = registry
			.getAvailable()
			.filter((model) => model.provider === "openai-codex")
			.map((model) => model.id);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

		const executableCodexIds = (await registry.getExecutableModels())
			.filter((model) => model.provider === "openai-codex")
			.map((model) => model.id);

		expect(executableCodexIds).toEqual(configuredCodexIds);
	});

	test("does not expose Codex models when its OAuth access token has no account id", async () => {
		const registry = createCodexRegistry("not-a-jwt");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const executableCodexModels = (await registry.getExecutableModels()).filter(
			(model) => model.provider === "openai-codex",
		);

		expect(executableCodexModels).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
