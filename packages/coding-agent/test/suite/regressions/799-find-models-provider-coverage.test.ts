import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { HostRequestHandlers } from "../../../src/core/kernel/index.js";
import { DEFAULT_RLM_MODEL_SEARCH_LIMIT } from "../../../src/core/rlm-runtime.js";
import { createHarness, type Harness } from "../harness.js";

const primaryProvider = "faux-799-alpha";

function registerAuthenticatedProvider(
	harness: Harness,
	provider: string,
	modelIds: string[],
): FauxProviderRegistration {
	const faux = registerFauxProvider({ provider, models: modelIds.map((id) => ({ id })) });
	harness.authStorage.setRuntimeApiKey(provider, "faux-key");
	harness.session.modelRegistry.registerProvider(provider, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	return faux;
}

describe("regression #799: rlm.find_models provider coverage", () => {
	it("samples every provider in an unqualified page and reports what it was cut from", async () => {
		const harness = await createHarness({
			provider: primaryProvider,
			models: Array.from({ length: 12 }, (_, index) => ({ id: `model-${String(index + 1).padStart(2, "0")}` })),
		});
		const extras = [
			registerAuthenticatedProvider(harness, "faux-799-bravo", ["model-01", "model-02", "model-03"]),
			registerAuthenticatedProvider(harness, "faux-799-charlie", ["model-01", "model-02"]),
			registerAuthenticatedProvider(harness, "faux-799-delta", ["model-01"]),
			registerAuthenticatedProvider(harness, "faux-799-echo", ["model-01"]),
		];
		try {
			const handlers = (
				harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
			)._createKernelHostHandlers();
			const findModels = handlers["rlm.find_models"];
			if (!findModels) throw new Error("Missing rlm.find_models host handler");

			// Alphabetical ordering would fill the whole page with faux-799-alpha models.
			await expect(findModels({ query: "" })).resolves.toEqual({
				models: [
					{
						provider: primaryProvider,
						id: "model-01",
						name: "model-01",
						selector: `${primaryProvider}/model-01`,
					},
					{
						provider: "faux-799-bravo",
						id: "model-01",
						name: "model-01",
						selector: "faux-799-bravo/model-01",
					},
					{
						provider: "faux-799-charlie",
						id: "model-01",
						name: "model-01",
						selector: "faux-799-charlie/model-01",
					},
					{
						provider: "faux-799-delta",
						id: "model-01",
						name: "model-01",
						selector: "faux-799-delta/model-01",
					},
					{
						provider: "faux-799-echo",
						id: "model-01",
						name: "model-01",
						selector: "faux-799-echo/model-01",
					},
					{
						provider: primaryProvider,
						id: "model-02",
						name: "model-02",
						selector: `${primaryProvider}/model-02`,
					},
					{
						provider: "faux-799-bravo",
						id: "model-02",
						name: "model-02",
						selector: "faux-799-bravo/model-02",
					},
					{
						provider: "faux-799-charlie",
						id: "model-02",
						name: "model-02",
						selector: "faux-799-charlie/model-02",
					},
				],
				total: 19,
				truncated: true,
				providers: [
					{ provider: primaryProvider, count: 12 },
					{ provider: "faux-799-bravo", count: 3 },
					{ provider: "faux-799-charlie", count: 2 },
					{ provider: "faux-799-delta", count: 1 },
					{ provider: "faux-799-echo", count: 1 },
				],
			});

			const page = await harness.session.findRlmModels("", DEFAULT_RLM_MODEL_SEARCH_LIMIT);
			const pageProviders = [...new Set(page.models.map((model) => model.provider))].sort();
			expect(pageProviders).toEqual(page.providers.map((entry) => entry.provider));
			expect(page.models.filter((model) => model.provider === primaryProvider)).toHaveLength(2);
			expect(page.models).toHaveLength(DEFAULT_RLM_MODEL_SEARCH_LIMIT);
			expect(page.total).toBeGreaterThan(page.models.length);

			const wider = await harness.session.findRlmModels("", 20);
			expect(wider.models).toHaveLength(19);
			expect(wider.truncated).toBe(false);
			expect(wider.total).toBe(19);
		} finally {
			for (const extra of extras) extra.unregister();
			harness.cleanup();
		}
	});

	it("matches a reordered query to the same models as the original", async () => {
		// Issue #810: token order decided whether a query matched at all.
		const harness = await createHarness({
			provider: primaryProvider,
			models: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-luna" }, { id: "deepseek-v4-flash" }],
		});
		try {
			const ordered = await harness.session.findRlmModels("gpt 5.6 sol", 8);
			const reordered = await harness.session.findRlmModels("5.6 gpt sol", 8);
			expect(ordered.models.map((model) => model.selector)).toEqual([`${primaryProvider}/gpt-5.6-sol`]);
			expect(reordered.models.map((model) => model.selector)).toEqual(ordered.models.map((model) => model.selector));
			expect(reordered.total).toBe(ordered.total);
			expect(reordered.truncated).toBe(false);

			const unmatched = await harness.session.findRlmModels("sonnet", 8);
			expect(unmatched.models).toEqual([]);
			expect(unmatched.total).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps query ranking ahead of provider coverage", async () => {
		const harness = await createHarness({
			provider: primaryProvider,
			models: [{ id: "opus-4" }, { id: "opus-4-mini" }, { id: "haiku-3" }],
		});
		const extra = registerAuthenticatedProvider(harness, "faux-799-bravo", ["team-opus-4"]);
		try {
			const ranked = await harness.session.findRlmModels("opus-4", 8);
			expect(ranked.models.map((model) => model.selector)).toEqual([
				`${primaryProvider}/opus-4`,
				`${primaryProvider}/opus-4-mini`,
				"faux-799-bravo/team-opus-4",
			]);
			expect(ranked.total).toBe(3);
			expect(ranked.truncated).toBe(false);
			expect(ranked.providers).toEqual([
				{ provider: primaryProvider, count: 2 },
				{ provider: "faux-799-bravo", count: 1 },
			]);

			const truncated = await harness.session.findRlmModels("opus-4", 2);
			expect(truncated.models.map((model) => model.selector)).toEqual([
				`${primaryProvider}/opus-4`,
				`${primaryProvider}/opus-4-mini`,
			]);
			expect(truncated.total).toBe(3);
			expect(truncated.truncated).toBe(true);
		} finally {
			extra.unregister();
			harness.cleanup();
		}
	});
});
