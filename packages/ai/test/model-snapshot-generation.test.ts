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

interface PackageManifest {
	scripts: Record<string, string>;
}

const catalogFixtures: Record<string, unknown> = {
	"https://models.dev/api.json": {
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
	},
	"https://openrouter.ai/api/v1/models": {
		data: [
			{
				id: "fixture/provider-model",
				name: "Fixture Provider Model",
				supported_parameters: ["tools", "reasoning"],
				architecture: { modality: "text", input_modalities: ["text"] },
				pricing: { prompt: "0.000001", completion: "0.000002" },
				context_length: 128000,
				top_provider: { max_completion_tokens: 8192 },
			},
		],
	},
	"https://ai-gateway.vercel.sh/v1/models": {
		data: [
			{
				id: "fixture/gateway-model",
				name: "Fixture Gateway Model",
				tags: ["tool-use"],
				pricing: { input: "0.000001", output: "0.000002" },
				context_window: 128000,
				max_tokens: 8192,
			},
		],
	},
	"https://api.pinference.ai/api/v1/models": {
		data: [
			{
				id: "fixture/provider-model",
				pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
				context_window: 128000,
				max_tokens: 8192,
			},
		],
	},
};

function createTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-model-snapshot-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createCatalogFetch(overrides: Record<string, Response | unknown> = {}): typeof fetch {
	return async (input) => {
		const url = String(input);
		const fixture = Object.hasOwn(overrides, url) ? overrides[url] : catalogFixtures[url];
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

	it("regenerates deterministically and records catalog provenance", async () => {
		const directory = createTemporaryDirectory();
		const firstOutput = join(directory, "first.ts");
		const secondOutput = join(directory, "second.ts");

		await refreshModels({ fetch: createCatalogFetch(), outputPath: firstOutput });
		await refreshModels({ fetch: createCatalogFetch(), outputPath: secondOutput });

		const first = readFileSync(firstOutput, "utf8");
		const second = readFileSync(secondOutput, "utf8");
		expect(first).toBe(second);
		expect(first).toContain("Catalog provenance (SHA-256 of canonical JSON)");
		for (const source of ["models.dev", "openrouter", "prime-inference", "vercel-ai-gateway"]) {
			expect(first).toMatch(new RegExp(`// - ${source}: .* sha256=[a-f0-9]{64}`));
		}
	});

	it.each([
		{
			name: "a partial source outage",
			overrides: {
				"https://openrouter.ai/api/v1/models": new Response("unavailable", { status: 503 }),
			},
			error: "openrouter returned HTTP 503",
		},
		{
			name: "malformed source JSON",
			overrides: {
				"https://models.dev/api.json": new Response("{", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			},
			error: "models.dev returned malformed JSON",
		},
		{
			name: "a zero-model source response",
			overrides: {
				"https://models.dev/api.json": {
					anthropic: { models: { unavailable: { tool_call: false } } },
				},
			},
			error: "models.dev produced zero usable models",
		},
	])("preserves the reviewed snapshot for $name", async ({ overrides, error }) => {
		const directory = createTemporaryDirectory();
		const outputPath = join(directory, "models.generated.ts");
		writeFileSync(outputPath, "reviewed snapshot\n");

		await expect(refreshModels({ fetch: createCatalogFetch(overrides), outputPath })).rejects.toThrow(error);

		expect(readFileSync(outputPath, "utf8")).toBe("reviewed snapshot\n");
		expect(readdirSync(directory)).toEqual(["models.generated.ts"]);
	});

	it("returns a nonzero CLI status when a required source fails", async () => {
		const directory = createTemporaryDirectory();
		const outputPath = join(directory, "models.generated.ts");
		writeFileSync(outputPath, "reviewed snapshot\n");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const exitCode = await runRefreshModelsCli({
			fetch: createCatalogFetch({
				"https://api.pinference.ai/api/v1/models": new Response("unavailable", { status: 503 }),
			}),
			outputPath,
		});

		expect(exitCode).toBe(1);
		expect(readFileSync(outputPath, "utf8")).toBe("reviewed snapshot\n");
		expect(consoleError).toHaveBeenCalledOnce();
	});
});
