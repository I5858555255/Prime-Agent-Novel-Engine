import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshModels, runRefreshModelsCli } from "../scripts/generate-models.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const temporaryDirectories: string[] = [];

const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const VERCEL_URL = "https://ai-gateway.vercel.sh/v1/models";
const PRIME_INFERENCE_URL = "https://api.pinference.ai/api/v1/models";
const QUOTED_MODEL_ID = 'fixture/provider-"model\nline';
const QUOTED_MODEL_NAME = 'Fixture "Provider"\nModel';

interface PackageManifest {
	scripts: Record<string, string>;
}

function createModelsDevCatalog(kimiIds: string[] = ["k2p5", "k2p6"]): Record<string, unknown> {
	const kimiModels: Record<string, unknown> = {};
	for (const id of kimiIds) {
		kimiModels[id] = {
			name: id,
			tool_call: true,
			reasoning: true,
			limit: { context: 128000, output: 8192 },
			cost: { input: id === "k2p6" ? 6 : 5, output: 2 },
			modalities: { input: ["text"] },
		};
	}

	return {
		anthropic: {
			models: {
				"claude-fixture": {
					name: "Claude Fixture",
					tool_call: true,
					reasoning: true,
					limit: { context: 128000, output: 8192 },
					cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
					modalities: { input: ["text"] },
				},
			},
		},
		"kimi-for-coding": { models: kimiModels },
	};
}

function createCatalogFixtures(modelsDevCatalog = createModelsDevCatalog()): Record<string, unknown> {
	return {
		[MODELS_DEV_URL]: modelsDevCatalog,
		[OPENROUTER_URL]: {
			data: [
				{
					id: QUOTED_MODEL_ID,
					name: QUOTED_MODEL_NAME,
					supported_parameters: ["tools", "reasoning"],
					architecture: { modality: "text", input_modalities: ["text"] },
					pricing: { prompt: "0.000001", completion: "0.000002" },
					context_length: 128000,
					top_provider: { max_completion_tokens: 8192 },
				},
			],
		},
		[VERCEL_URL]: {
			data: [
				{
					id: 'fixture/gateway-"model',
					name: 'Fixture "Gateway" Model',
					tags: ["tool-use"],
					pricing: { input: "0.000001", output: "0.000002" },
					context_window: 128000,
					max_tokens: 8192,
				},
			],
		},
		[PRIME_INFERENCE_URL]: {
			data: [
				{
					id: QUOTED_MODEL_ID,
					pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
					context_window: 128000,
					max_tokens: 8192,
				},
			],
		},
	};
}

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-model-snapshot-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createCatalogFetch(
	overrides: Record<string, Response | unknown> = {},
	fixtures = createCatalogFixtures(),
): typeof fetch {
	return async (input) => {
		const url = String(input);
		const fixture = Object.hasOwn(overrides, url) ? overrides[url] : fixtures[url];
		if (fixture instanceof Response) {
			return fixture;
		}
		if (fixture === undefined) {
			return new Response("not found", { status: 404 });
		}
		return new Response(JSON.stringify(fixture), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

function createReviewedSnapshot(): { directory: string; outputPath: string } {
	const directory = createTemporaryDirectory();
	const outputPath = join(directory, "models.generated.ts");
	writeFileSync(outputPath, "reviewed snapshot\n");
	return { directory, outputPath };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("reviewed model snapshot generation", () => {
	it("keeps normal and release builds on the committed snapshot", () => {
		const rootPackage = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as PackageManifest;
		const aiPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PackageManifest;

		expect(rootPackage.scripts.build).toContain("cd ../ai && npm run build");
		expect(aiPackage.scripts.build).toBe("tsgo -p tsconfig.build.json");
		expect(aiPackage.scripts.prepublishOnly).toContain("npm run build");
		expect(aiPackage.scripts.build).not.toMatch(/generate-models|refresh-models/);
		expect(rootPackage.scripts["refresh-models"]).toBe("npm --prefix packages/ai run refresh-models");
		expect(aiPackage.scripts["refresh-models"]).toBe("npx tsx scripts/generate-models.ts");
	});

	it("regenerates deterministically, escapes catalog strings, and records provenance", async () => {
		const directory = createTemporaryDirectory();
		const firstOutput = join(directory, "first.ts");
		const secondOutput = join(directory, "second.ts");

		await refreshModels({ fetch: createCatalogFetch(), outputPath: firstOutput });
		await refreshModels({ fetch: createCatalogFetch(), outputPath: secondOutput });

		const first = readFileSync(firstOutput, "utf8");
		const second = readFileSync(secondOutput, "utf8");
		expect(first).toBe(second);
		expect(first).toContain(`id: ${JSON.stringify(QUOTED_MODEL_ID)}`);
		expect(first).toContain(`name: ${JSON.stringify(QUOTED_MODEL_NAME)}`);
		expect(first).toContain("Catalog provenance (SHA-256 of canonical JSON)");
		for (const source of ["models.dev", "openrouter", "prime-inference", "vercel-ai-gateway"]) {
			expect(first).toMatch(new RegExp(`// - ${source}: .* sha256=[a-f0-9]{64}`));
		}
	});

	it("uses explicit Kimi alias precedence independent of catalog insertion order", async () => {
		const directory = createTemporaryDirectory();
		const firstOutput = join(directory, "first.ts");
		const secondOutput = join(directory, "second.ts");
		const firstFixtures = createCatalogFixtures(createModelsDevCatalog(["k2p5", "k2p6"]));
		const secondFixtures = createCatalogFixtures(createModelsDevCatalog(["k2p6", "k2p5"]));

		await refreshModels({ fetch: createCatalogFetch({}, firstFixtures), outputPath: firstOutput });
		await refreshModels({ fetch: createCatalogFetch({}, secondFixtures), outputPath: secondOutput });

		const first = readFileSync(firstOutput, "utf8");
		const second = readFileSync(secondOutput, "utf8");
		expect(first).toBe(second);
		expect(first).toMatch(/"kimi-for-coding": \{[\s\S]*?input: 6,/);
		const provenance = (output: string) => output.match(/^\/\/ - models\.dev: .*$/m)?.[0];
		expect(provenance(first)).toBe(provenance(second));
	});

	it.each([
		{ source: "models.dev", url: MODELS_DEV_URL },
		{ source: "openrouter", url: OPENROUTER_URL },
		{ source: "vercel-ai-gateway", url: VERCEL_URL },
		{ source: "prime-inference", url: PRIME_INFERENCE_URL },
	])("preserves the reviewed snapshot when $source is unavailable", async ({ source, url }) => {
		const { directory, outputPath } = createReviewedSnapshot();

		await expect(
			refreshModels({
				fetch: createCatalogFetch({ [url]: new Response("unavailable", { status: 503 }) }),
				outputPath,
			}),
		).rejects.toThrow(`${source} returned HTTP 503`);

		expect(readFileSync(outputPath, "utf8")).toBe("reviewed snapshot\n");
		expect(readdirSync(directory)).toEqual(["models.generated.ts"]);
	});

	it.each([
		{
			source: "models.dev",
			url: MODELS_DEV_URL,
			payload: { anthropic: { models: { unavailable: { tool_call: false } } } },
		},
		{
			source: "openrouter",
			url: OPENROUTER_URL,
			payload: { data: [{ id: "fixture/no-tools", supported_parameters: [] }] },
		},
		{
			source: "vercel-ai-gateway",
			url: VERCEL_URL,
			payload: { data: [{ id: "fixture/no-tools", tags: [] }] },
		},
		{
			source: "prime-inference",
			url: PRIME_INFERENCE_URL,
			payload: {
				data: [
					{
						id: "internal/private-model",
						pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
					},
				],
			},
		},
	])("preserves the reviewed snapshot when $source produces zero usable models", async ({ source, url, payload }) => {
		const { directory, outputPath } = createReviewedSnapshot();

		await expect(refreshModels({ fetch: createCatalogFetch({ [url]: payload }), outputPath })).rejects.toThrow(
			`${source} produced zero usable models`,
		);

		expect(readFileSync(outputPath, "utf8")).toBe("reviewed snapshot\n");
		expect(readdirSync(directory)).toEqual(["models.generated.ts"]);
	});

	it("rejects a models.dev catalog whose only tool model is an unsupported MiniMax release", async () => {
		const { directory, outputPath } = createReviewedSnapshot();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const exitCode = await runRefreshModelsCli({
			fetch: createCatalogFetch({
				[MODELS_DEV_URL]: {
					minimax: {
						models: {
							"MiniMax-M2.6": {
								name: "MiniMax M2.6",
								tool_call: true,
								limit: { context: 204800, output: 131072 },
							},
						},
					},
				},
			}),
			outputPath,
		});

		expect(exitCode).toBe(1);
		expect(readFileSync(outputPath, "utf8")).toBe("reviewed snapshot\n");
		expect(readdirSync(directory)).toEqual(["models.generated.ts"]);
		expect(consoleError).toHaveBeenCalledOnce();
		expect(String(consoleError.mock.calls[0]?.[0])).toContain("models.dev produced zero usable models");
	});

	it("preserves the reviewed snapshot for malformed source JSON", async () => {
		const { directory, outputPath } = createReviewedSnapshot();

		await expect(
			refreshModels({
				fetch: createCatalogFetch({
					[MODELS_DEV_URL]: new Response("{", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				}),
				outputPath,
			}),
		).rejects.toThrow("models.dev returned malformed JSON");

		expect(readFileSync(outputPath, "utf8")).toBe("reviewed snapshot\n");
		expect(readdirSync(directory)).toEqual(["models.generated.ts"]);
	});

	it.each([
		{
			name: "wrong-type catalog numbers",
			url: VERCEL_URL,
			payload: {
				data: [
					{
						id: "fixture/wrong-context-type",
						tags: ["tool-use"],
						context_window: "128000",
						max_tokens: 8192,
					},
				],
			},
			errorPath: "context_window",
		},
		{
			name: "non-finite numeric strings",
			url: OPENROUTER_URL,
			payload: {
				data: [
					{
						id: "fixture/non-finite-price",
						supported_parameters: ["tools"],
						pricing: { prompt: "Infinity" },
					},
				],
			},
			errorPath: "pricing.prompt",
		},
	])("rejects $name with a nonzero CLI status", async ({ url, payload, errorPath }) => {
		const { directory, outputPath } = createReviewedSnapshot();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const exitCode = await runRefreshModelsCli({
			fetch: createCatalogFetch({ [url]: payload }),
			outputPath,
		});

		expect(exitCode).toBe(1);
		expect(readFileSync(outputPath, "utf8")).toBe("reviewed snapshot\n");
		expect(readdirSync(directory)).toEqual(["models.generated.ts"]);
		expect(consoleError).toHaveBeenCalledOnce();
		expect(String(consoleError.mock.calls[0]?.[0])).toContain(errorPath);
	});
});
