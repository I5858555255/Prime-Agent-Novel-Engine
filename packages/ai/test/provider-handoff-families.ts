import { readFileSync } from "node:fs";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";
import { MODELS } from "../src/models.generated.js";
import type { Api, Model } from "../src/types.js";

const handoffApiSchema = Type.Union([
	Type.Literal("anthropic-messages"),
	Type.Literal("azure-openai-responses"),
	Type.Literal("bedrock-converse-stream"),
	Type.Literal("google-generative-ai"),
	Type.Literal("google-vertex"),
	Type.Literal("mistral-conversations"),
	Type.Literal("openai-codex-responses"),
	Type.Literal("openai-completions"),
	Type.Literal("openai-responses"),
]);

const providerHandoffFamilyFileSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		families: Type.Array(
			Type.Object(
				{
					api: handoffApiSchema,
					provider: Type.String({ minLength: 1 }),
					model: Type.String({ minLength: 1 }),
					synthetic: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

const providerHandoffFamilyFileValidator = Schema.Compile(providerHandoffFamilyFileSchema);
const supportedHandoffApis = new Set<string>([
	"anthropic-messages",
	"azure-openai-responses",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"openai-codex-responses",
	"openai-completions",
	"openai-responses",
]);

export type ProviderHandoffFamilyFile = Static<typeof providerHandoffFamilyFileSchema>;
export type ProviderHandoffFamily = ProviderHandoffFamilyFile["families"][number];

export interface ResolvedProviderHandoffFamily {
	fixture: ProviderHandoffFamily;
	model: Model<Api>;
}

export function parseProviderHandoffFamilyFile(serialized: string): ProviderHandoffFamilyFile {
	const parsed: unknown = JSON.parse(serialized);
	if (!providerHandoffFamilyFileValidator.Check(parsed)) {
		throw new Error(
			`Provider handoff family fixture failed schema validation: ${JSON.stringify(providerHandoffFamilyFileValidator.Errors(parsed))}`,
		);
	}
	return parsed;
}

export function loadProviderHandoffFamilyFile(): ProviderHandoffFamilyFile {
	const fixtureUrl = new URL("./fixtures/provider-handoffs/v1/families.json", import.meta.url);
	return parseProviderHandoffFamilyFile(readFileSync(fixtureUrl, "utf8"));
}

export function resolveProviderHandoffFamilies(file: ProviderHandoffFamilyFile): ResolvedProviderHandoffFamily[] {
	const catalog = MODELS as unknown as Record<string, Record<string, Model<Api>>>;
	return file.families.map((fixture) => {
		if (fixture.synthetic) {
			return { fixture, model: createSyntheticModel(fixture) };
		}
		const model = catalog[fixture.provider]?.[fixture.model];
		if (!model) throw new Error(`Unknown provider handoff family model: ${fixture.provider}/${fixture.model}`);
		if (model.api !== fixture.api) {
			throw new Error(
				`Provider handoff family API mismatch for ${fixture.provider}/${fixture.model}: ${model.api} != ${fixture.api}`,
			);
		}
		return { fixture, model };
	});
}

export function getCatalogProviderHandoffModels(): ResolvedProviderHandoffFamily[] {
	const catalog = MODELS as unknown as Record<string, Record<string, Model<Api>>>;
	const families: ResolvedProviderHandoffFamily[] = [];
	for (const [provider, models] of Object.entries(catalog)) {
		for (const model of Object.values(models)) {
			if (!supportedHandoffApis.has(model.api)) {
				throw new Error(`Unsupported catalog handoff API: ${model.api}`);
			}
			families.push({
				fixture: {
					api: model.api as ProviderHandoffFamily["api"],
					provider,
					model: model.id,
					synthetic: false,
				},
				model,
			});
		}
	}
	return families;
}

function createSyntheticModel(fixture: ProviderHandoffFamily): Model<Api> {
	if (fixture.api !== "google-generative-ai") {
		throw new Error(
			`Unsupported synthetic provider handoff family: ${fixture.api}/${fixture.provider}/${fixture.model}`,
		);
	}
	return {
		id: fixture.model,
		name: `Synthetic ${fixture.model}`,
		api: fixture.api,
		provider: fixture.provider,
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	};
}
