import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../../../src/config.js";
import { createHarness } from "../harness.js";

const codexProvider = "openai-codex";

function openAICodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("issue #702 ChatGPT model discovery client_version", () => {
	it("does not send the prime-agent package version as the codex client_version", async () => {
		const harness = await createHarness({
			provider: codexProvider,
			models: [{ id: "parent-model" }],
		});
		const fetchModels = vi.fn(
			async (_input: unknown) =>
				new Response(JSON.stringify({ models: [{ slug: "parent-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			await expect(harness.session.findRlmModels("parent", 8)).resolves.toMatchObject({
				models: [{ selector: `${codexProvider}/parent-model` }],
			});
			expect(fetchModels).toHaveBeenCalledOnce();
			const requestedUrl = new URL(String(fetchModels.mock.calls[0]![0]));
			const clientVersion = requestedUrl.searchParams.get("client_version");
			expect(clientVersion).toBeTruthy();
			expect(clientVersion).not.toBe(VERSION);
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});

	it("does not cache an empty ChatGPT model catalog as a successful discovery", async () => {
		const harness = await createHarness({
			provider: codexProvider,
			models: [{ id: "parent-model" }],
		});
		const fetchModels = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [{ slug: "parent-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			await expect(harness.session.findRlmModels("parent", 8)).resolves.toEqual({ models: [] });
			await expect(harness.session.findRlmModels("parent", 8)).resolves.toMatchObject({
				models: [{ selector: `${codexProvider}/parent-model` }],
			});
			expect(fetchModels).toHaveBeenCalledTimes(2);
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});
});
