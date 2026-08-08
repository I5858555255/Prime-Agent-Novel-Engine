import { readFileSync } from "node:fs";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";
import type { HandoffApi } from "./provider-handoff-fixtures.js";

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
const rawEventSchema = Type.Record(Type.String(), Type.Unknown());
const sensitiveFixtureKeys = new Set(["auth", "authorization", "passwd", "token"]);

const providerResponseFixtureFileSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		responses: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					api: handoffApiSchema,
					transport: Type.Union([
						Type.Literal("anthropic-sse"),
						Type.Literal("codex-sse"),
						Type.Literal("google-events"),
						Type.Literal("mistral-events"),
						Type.Literal("openai-chunks"),
						Type.Literal("openai-events"),
						Type.Literal("smithy-events"),
					]),
					success: Type.Array(rawEventSchema, { minItems: 1 }),
					error: Type.Array(rawEventSchema, { minItems: 1 }),
					expected: Type.Object(
						{
							thinkingText: Type.String({ minLength: 1 }),
							thinkingSignatureMarker: nullableStringSchema,
							toolThoughtSignatureMarker: nullableStringSchema,
							toolCallId: Type.String({ minLength: 1 }),
							errorMarker: Type.String({ minLength: 1 }),
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

const providerResponseFixtureFileValidator = Schema.Compile(providerResponseFixtureFileSchema);

export type ProviderResponseFixtureFile = Static<typeof providerResponseFixtureFileSchema>;
export type ProviderResponseFixture = ProviderResponseFixtureFile["responses"][number];

export function parseProviderResponseFixtureFile(serialized: string): ProviderResponseFixtureFile {
	const parsed: unknown = JSON.parse(serialized);
	if (!providerResponseFixtureFileValidator.Check(parsed)) {
		throw new Error(
			`Provider response fixture failed schema validation: ${JSON.stringify(providerResponseFixtureFileValidator.Errors(parsed))}`,
		);
	}

	const ids = new Set<string>();
	const apis = new Set<HandoffApi>();
	for (const fixture of parsed.responses) {
		if (ids.has(fixture.id)) throw new Error(`Duplicate provider response fixture id: ${fixture.id}`);
		if (apis.has(fixture.api)) throw new Error(`Duplicate provider response fixture api: ${fixture.api}`);
		ids.add(fixture.id);
		apis.add(fixture.api);
	}
	validateFixtureSanitization(parsed);
	return parsed;
}

export function assertProviderResponseFixtureApiCompleteness(
	file: ProviderResponseFixtureFile,
	registeredApis: readonly string[],
): void {
	const fixtureApis = file.responses.map((fixture) => fixture.api).sort();
	const expectedApis = [...registeredApis].sort();
	if (
		fixtureApis.length !== new Set(fixtureApis).size ||
		expectedApis.length !== new Set(expectedApis).size ||
		JSON.stringify(fixtureApis) !== JSON.stringify(expectedApis)
	) {
		throw new Error(
			`Provider response fixture completeness failure: fixtures=${JSON.stringify(fixtureApis)}, registered=${JSON.stringify(expectedApis)}`,
		);
	}
}

export function loadProviderResponseFixtureFile(): ProviderResponseFixtureFile {
	const fixtureUrl = new URL("./fixtures/provider-handoffs/v1/responses.json", import.meta.url);
	return parseProviderResponseFixtureFile(readFileSync(fixtureUrl, "utf8"));
}

function validateFixtureSanitization(file: ProviderResponseFixtureFile): void {
	for (const fixture of file.responses) {
		const allowedToolIds = new Set(fixture.expected.toolCallId.split("|"));
		visitFixture([fixture.success, fixture.error], (key, value) => {
			const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
			if (isSensitiveFixtureKey(normalizedKey)) {
				throw new Error(`Provider response fixture sanitization rejected auth field: ${key}`);
			}
			if (
				isProviderIdentifierKey(normalizedKey) &&
				typeof value === "string" &&
				!allowedToolIds.has(value) &&
				!isFixtureMarkedIdentifier(value)
			) {
				throw new Error(`Provider response fixture sanitization rejected provider ID: ${value}`);
			}
			if (
				typeof value === "string" &&
				/(?:\bbearer\s+[a-z0-9._-]{8,}|\bsk-[a-z0-9_-]{8,}|\bAIza[a-z0-9_-]{20,}|\bAKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,})/i.test(
					value,
				)
			) {
				throw new Error("Provider response fixture sanitization rejected credential-like content");
			}
		});
	}
}

function isSensitiveFixtureKey(normalizedKey: string): boolean {
	return (
		sensitiveFixtureKeys.has(normalizedKey) ||
		/(?:apikey|credential|credentials|password|privatekey|secret|secretaccesskey|secretkey)$/.test(normalizedKey) ||
		/(?:access|api|auth|csrf|id|refresh|session)token$/.test(normalizedKey)
	);
}

function isProviderIdentifierKey(normalizedKey: string): boolean {
	return normalizedKey.endsWith("id");
}

function isFixtureMarkedIdentifier(value: string): boolean {
	return /^[a-z0-9_-]+$/i.test(value) && /(?:^|[_-])fixture(?:[_-]|$)/i.test(value);
}

function visitFixture(value: unknown, callback: (key: string, value: unknown) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) visitFixture(item, callback);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, child] of Object.entries(value)) {
		callback(key, child);
		visitFixture(child, callback);
	}
}
