import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../../../src/config.js";
import { createHarness } from "../harness.js";

function openAICodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("#1011 Luna subagent selection", () => {
	it("discovers and runs Luna from a Sol parent with Codex subscription auth", async () => {
		vi.stubEnv("RLM_DEPTH", "0");
		vi.stubEnv("RLM_MAX_DEPTH", "1");
		const provider = "openai-codex";
		const harness = await createHarness({
			provider,
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "gpt-5.6-luna", reasoning: true },
			],
		});
		const fetchModels = vi.fn(async (input: string | URL | Request) => {
			const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
			expect(requestUrl.searchParams.get("client_version")).toBe(VERSION);
			return new Response(JSON.stringify({ models: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchModels);
		try {
			expect(harness.session.model?.id).toBe("gpt-5.6-sol");
			harness.authStorage.setRuntimeApiKey(provider, openAICodexToken("account-1"));
			await expect(harness.session.findRlmModels("luna", 8)).resolves.toMatchObject({
				models: [{ selector: "openai-codex/gpt-5.6-luna" }],
			});

			harness.setResponses([fauxAssistantMessage("Luna child completed")]);
			await expect(
				harness.session.runRlmChild("Run on Luna", { model: "openai-codex/gpt-5.6-luna" }),
			).resolves.toMatchObject({ model: "openai-codex/gpt-5.6-luna" });
			await vi.waitFor(async () => {
				const child = (await harness.session.listRlmSubagents()).subagents[0];
				expect(harness.session.getRlmChildSession(child!.rlm_child_id)?.model?.id).toBe("gpt-5.6-luna");
			});
			expect(fetchModels).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			harness.cleanup();
		}
	});
});
