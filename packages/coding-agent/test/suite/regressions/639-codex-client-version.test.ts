import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.js";

function openAICodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("issue #639 codex client version", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not send Prime Agent version as Codex client_version", async () => {
		const harness = await createHarness({
			provider: "openai-codex",
			models: [{ id: "parent-model" }],
		});
		harnesses.push(harness);
		const fetchModels = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [{ slug: "parent-model" }, { slug: "gpt-5.6-luna" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey("openai-codex", openAICodexToken("account-1"));
			const discovered = await harness.session.findRlmModels("", 20);
			expect(discovered.models.length).toBeGreaterThanOrEqual(1);
			expect(fetchModels).toHaveBeenCalledWith(
				expect.not.stringContaining("client_version=0.7.1"),
				expect.any(Object),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("filters Codex models against the catalog response", async () => {
		const harness = await createHarness({
			provider: "openai-codex",
			models: [{ id: "parent-model" }, { id: "unsupported-model" }],
		});
		harnesses.push(harness);
		const fetchModels = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [{ slug: "parent-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey("openai-codex", openAICodexToken("account-1"));
			const discovered = await harness.session.findRlmModels("", 20);
			expect(discovered.models.map((model) => model.selector)).toEqual(["openai-codex/parent-model"]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
