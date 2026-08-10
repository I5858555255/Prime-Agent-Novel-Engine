import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.js";

function openAICodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("#639 OpenAI Codex model discovery", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		vi.unstubAllGlobals();
		harness?.cleanup();
		harness = undefined;
	});

	it("sends a Codex client version that advertises GPT-5.6 models", async () => {
		harness = await createHarness({
			provider: "openai-codex",
			models: [{ id: "gpt-5.6-luna" }],
		});
		const fetchModels = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			expect(url.searchParams.get("client_version")).toBe("0.144.0");
			return new Response(JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchModels);
		harness.authStorage.setRuntimeApiKey("openai-codex", openAICodexToken("account-1"));

		await expect(harness.session.findRlmModels("luna", 8)).resolves.toMatchObject({
			models: [{ selector: "openai-codex/gpt-5.6-luna" }],
		});
		expect(fetchModels).toHaveBeenCalledOnce();
	});
});
