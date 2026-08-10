import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";
import type { AssistantMessage, Context, Message, Usage } from "../src/types.js";

export const PROVIDER_HANDOFF_FIXTURE_SCHEMA_VERSION = 1;

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

const nullableStringSchema = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

const providerHandoffFixtureFileSchema = Type.Object(
	{
		schemaVersion: Type.Literal(PROVIDER_HANDOFF_FIXTURE_SCHEMA_VERSION),
		coverage: Type.Object(
			{
				userImages: Type.Literal(true),
				toolResultImages: Type.Literal(true),
				toolErrors: Type.Literal(true),
				providerErrors: Type.Literal(true),
			},
			{ additionalProperties: false },
		),
		images: Type.Object(
			{
				user: Type.Object(
					{ mimeType: Type.Literal("image/png"), data: Type.String({ minLength: 1 }) },
					{ additionalProperties: false },
				),
				toolResult: Type.Object(
					{ mimeType: Type.Literal("image/png"), data: Type.String({ minLength: 1 }) },
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		fixtures: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					source: Type.Object(
						{
							api: handoffApiSchema,
							provider: Type.String({ minLength: 1 }),
							model: Type.String({ minLength: 1 }),
						},
						{ additionalProperties: false },
					),
					protocol: Type.Object(
						{
							toolCallId: Type.String({ minLength: 1 }),
							thinkingSignature: nullableStringSchema,
							toolThoughtSignature: nullableStringSchema,
							signatureMarker: nullableStringSchema,
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

const providerHandoffFixtureFileValidator = Schema.Compile(providerHandoffFixtureFileSchema);

export type ProviderHandoffFixtureFile = Static<typeof providerHandoffFixtureFileSchema>;
export type ProviderHandoffFixture = ProviderHandoffFixtureFile["fixtures"][number];
export type ProviderHandoffImages = ProviderHandoffFixtureFile["images"];
export type HandoffApi = ProviderHandoffFixture["source"]["api"];

interface HandoffSource {
	api: HandoffApi;
	provider: string;
	model: string;
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function parseProviderHandoffFixtureFile(serialized: string): ProviderHandoffFixtureFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch (error) {
		throw new Error("Provider handoff fixture is not valid JSON", { cause: error });
	}

	if (!providerHandoffFixtureFileValidator.Check(parsed)) {
		const errors = providerHandoffFixtureFileValidator.Errors(parsed);
		throw new Error(`Provider handoff fixture failed schema validation: ${JSON.stringify(errors)}`);
	}

	validateFixtureInvariants(parsed);
	return parsed;
}

export function loadProviderHandoffFixtureFile(): ProviderHandoffFixtureFile {
	const fixtureUrl = new URL("./fixtures/provider-handoffs/v1/fixtures.json", import.meta.url);
	return parseProviderHandoffFixtureFile(readFileSync(fixtureUrl, "utf8"));
}

export function createHandoffContext(
	fixture: ProviderHandoffFixture,
	images: ProviderHandoffImages,
	source: HandoffSource = fixture.source,
): Context {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Sanitized provider reasoning summary.",
				...(fixture.protocol.thinkingSignature ? { thinkingSignature: fixture.protocol.thinkingSignature } : {}),
			},
			{ type: "text", text: "I will inspect the fixture." },
			{
				type: "toolCall",
				id: fixture.protocol.toolCallId,
				name: "inspect_fixture",
				arguments: { path: "sanitized.txt" },
				...(fixture.protocol.toolThoughtSignature
					? { thoughtSignature: fixture.protocol.toolThoughtSignature }
					: {}),
			},
		],
		api: source.api,
		provider: source.provider,
		model: source.model,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 1_700_000_000_001,
	};

	const providerError: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Partial output from a failed provider response." }],
		api: source.api,
		provider: source.provider,
		model: source.model,
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage: "fixture provider error; request identifiers redacted",
		timestamp: 1_700_000_000_003,
	};

	const messages: Message[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "Inspect this sanitized image." },
				{ type: "image", data: images.user.data, mimeType: images.user.mimeType },
			],
			timestamp: 1_700_000_000_000,
		},
		assistant,
		{
			role: "toolResult",
			toolCallId: fixture.protocol.toolCallId,
			toolName: "inspect_fixture",
			content: [
				{ type: "text", text: "fixture tool failure" },
				{ type: "image", data: images.toolResult.data, mimeType: images.toolResult.mimeType },
			],
			isError: true,
			timestamp: 1_700_000_000_002,
		},
		providerError,
	];

	return {
		systemPrompt: "Exercise the sanitized handoff contract.",
		messages,
	};
}

function validateFixtureInvariants(file: ProviderHandoffFixtureFile): void {
	const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	for (const [name, image] of Object.entries(file.images)) {
		const decoded = Buffer.from(image.data, "base64");
		if (decoded.toString("base64") !== image.data || !decoded.subarray(0, pngSignature.length).equals(pngSignature)) {
			throw new Error(`Provider handoff ${name} image is not canonical PNG data`);
		}
	}
	if (file.images.user.data === file.images.toolResult.data) {
		throw new Error("Provider handoff user and tool-result images must be distinguishable");
	}

	const ids = new Set<string>();

	for (const fixture of file.fixtures) {
		if (ids.has(fixture.id)) throw new Error(`Duplicate provider handoff fixture id: ${fixture.id}`);
		ids.add(fixture.id);

		const { signatureMarker, thinkingSignature, toolThoughtSignature } = fixture.protocol;
		const signatures = [thinkingSignature, toolThoughtSignature].filter(
			(signature): signature is string => signature !== null,
		);
		if (signatureMarker === null && signatures.length > 0) {
			throw new Error(`Fixture ${fixture.id} has a signature without a signature marker`);
		}
		if (signatureMarker !== null && !signatures.some((signature) => signature.includes(signatureMarker))) {
			throw new Error(`Fixture ${fixture.id} signature marker is not present in a signature`);
		}
	}
}
