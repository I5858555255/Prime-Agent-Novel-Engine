import { readFileSync } from "node:fs";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";
import type { Api, KnownApi, KnownProvider, Model } from "../src/types.js";

export const PROVIDER_HANDOFF_FAMILY_SCHEMA_VERSION = 2;

export const STABLE_HANDOFF_APIS = requireAllKnownApis(
	[
		"anthropic-messages",
		"azure-openai-responses",
		"bedrock-converse-stream",
		"google-generative-ai",
		"google-vertex",
		"mistral-conversations",
		"openai-codex-responses",
		"openai-completions",
		"openai-responses",
	] as const,
	{},
);

export const STABLE_HANDOFF_PROVIDERS = requireAllKnownProviders(
	[
		"amazon-bedrock",
		"anthropic",
		"azure-openai-responses",
		"cerebras",
		"cloudflare-ai-gateway",
		"cloudflare-workers-ai",
		"deepseek",
		"fireworks",
		"github-copilot",
		"google",
		"google-vertex",
		"groq",
		"huggingface",
		"kimi-coding",
		"minimax",
		"minimax-cn",
		"mistral",
		"moonshotai",
		"moonshotai-cn",
		"openai",
		"openai-codex",
		"opencode",
		"opencode-go",
		"openrouter",
		"prime-inference",
		"vercel-ai-gateway",
		"xai",
		"xiaomi",
		"xiaomi-token-plan-ams",
		"xiaomi-token-plan-cn",
		"xiaomi-token-plan-sgp",
		"zai",
	] as const,
	{},
);

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

const modelMetadataSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		baseUrl: Type.String(),
		reasoning: Type.Boolean(),
		thinkingLevelMap: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
		input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
			minItems: 1,
			uniqueItems: true,
		}),
		cost: Type.Object(
			{
				input: Type.Number(),
				output: Type.Number(),
				cacheRead: Type.Number(),
				cacheWrite: Type.Number(),
			},
			{ additionalProperties: false },
		),
		contextWindow: Type.Number(),
		maxTokens: Type.Number(),
		featured: Type.Optional(Type.Boolean()),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		compat: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

const providerHandoffFamilySchema = Type.Object(
	{
		api: handoffApiSchema,
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		synthetic: Type.Boolean(),
		metadata: modelMetadataSchema,
	},
	{ additionalProperties: false },
);

const providerHandoffFamilyFileSchema = Type.Object(
	{
		schemaVersion: Type.Literal(PROVIDER_HANDOFF_FAMILY_SCHEMA_VERSION),
		families: Type.Array(providerHandoffFamilySchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const providerHandoffFamilyFileValidator = Schema.Compile(providerHandoffFamilyFileSchema);

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
	return file.families.map((fixture) => ({
		fixture,
		model: {
			id: fixture.model,
			api: fixture.api,
			provider: fixture.provider,
			...fixture.metadata,
		} as Model<Api>,
	}));
}

export function snapshotProviderHandoffFamily(model: Model<Api>, synthetic: boolean): ProviderHandoffFamily {
	const serializedModel = JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
	const { id, api, provider, ...metadata } = serializedModel;
	const parsed = parseProviderHandoffFamilyFile(
		JSON.stringify({
			schemaVersion: PROVIDER_HANDOFF_FAMILY_SCHEMA_VERSION,
			families: [{ api, provider, model: id, synthetic, metadata }],
		}),
	);
	return parsed.families[0];
}

function requireAllKnownApis<const T extends readonly KnownApi[]>(
	apis: T,
	_missing: Record<Exclude<KnownApi, T[number]>, never>,
): T {
	return apis;
}

function requireAllKnownProviders<const T extends readonly KnownProvider[]>(
	providers: T,
	_missing: Record<Exclude<KnownProvider, T[number]>, never>,
): T {
	return providers;
}
