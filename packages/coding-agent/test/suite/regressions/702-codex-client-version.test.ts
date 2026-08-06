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

describe("issue #702 codex model discovery must not send prime-agent's version as client_version", () => {
	it("pins a Codex CLI client_version instead of the package VERSION", async () => {
		const harness = await createHarness({
			provider: codexProvider,
			models: [{ id: "parent-model" }],
		});
		const fetchModels = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ models: [{ slug: "parent-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			const discovered = await harness.session.findRlmModels("parent model", 20);
			expect(discovered.models.map((model) => model.selector)).toContain(`${codexProvider}/parent-model`);

			const codexCalls = fetchModels.mock.calls.filter((call) => String(call[0]).includes("/codex/models"));
			expect(codexCalls.length).toBeGreaterThan(0);
			const requestedUrl = new URL(String(codexCalls[0]![0]));
			const clientVersion = requestedUrl.searchParams.get("client_version");
			// The backend gates the catalog by Codex CLI version; prime-agent's
			// own version reads as an ancient client and yields an empty catalog.
			expect(clientVersion).not.toBe(VERSION);
			expect(clientVersion).toMatch(/^0\.1\d\d\.\d+$/);
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});
});
