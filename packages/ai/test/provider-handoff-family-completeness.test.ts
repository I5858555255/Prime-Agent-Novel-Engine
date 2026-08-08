import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { getApiProviders } from "../src/api-registry.js";
import { resetApiProviders } from "../src/providers/register-builtins.js";
import type { Api, Model, SimpleStreamOptions, ThinkingLevel, Tool } from "../src/types.js";
import {
	getCatalogProviderHandoffModels,
	loadProviderHandoffFamilyFile,
	parseProviderHandoffFamilyFile,
	type ResolvedProviderHandoffFamily,
	resolveProviderHandoffFamilies,
} from "./provider-handoff-families.js";
import { createHandoffContext, loadProviderHandoffFixtureFile } from "./provider-handoff-fixtures.js";
import { getTargetTransportAttempts, resetTargetTransportAttempts } from "./provider-handoff-target-transport.js";

const familyFile = loadProviderHandoffFamilyFile();
const resolvedFamilies = resolveProviderHandoffFamilies(familyFile);
const handoffFixtureFile = loadProviderHandoffFixtureFile();
const sourceFixture = getCanonicalSourceFixture();

const REQUIRED_SYNTHETIC_FAMILIES = new Set([
	"google-generative-ai|opencode|claude-sonnet-4-5",
	"google-generative-ai|opencode|gpt-oss-120b",
]);
const thinkingLevels = requireAllThinkingLevels(["minimal", "low", "medium", "high", "xhigh", "max"] as const, {});
const reasoningProfiles = [undefined, ...thinkingLevels] as const;
const inspectFixtureTool: Tool = {
	name: "inspect_fixture",
	description: "Inspect a sanitized fixture path.",
	parameters: Type.Object({ path: Type.String() }),
};
const CODEX_FIXTURE_TOKEN =
	"e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9maXh0dXJlIn19.fixture";
const PAYLOAD_CAPTURED = "provider family payload captured";
const HERMETIC_BASE_URL = "http://127.0.0.1:9";

function requireAllThinkingLevels<const T extends readonly ThinkingLevel[]>(
	levels: T,
	_missing: Record<Exclude<ThinkingLevel, T[number]>, never>,
): T {
	return levels;
}

describe("provider handoff behavior-family completeness", () => {
	it("validates and deterministically serializes the versioned family manifest", () => {
		const serialized = JSON.stringify(familyFile);
		expect(JSON.stringify(parseProviderHandoffFamilyFile(serialized))).toBe(serialized);
		expect(() =>
			parseProviderHandoffFamilyFile(serialized.replace('"schemaVersion":1', '"schemaVersion":2')),
		).toThrow("schema validation");
	});

	it("requires one representative for every effective catalog payload shape", async () => {
		const syntheticFamilies = resolvedFamilies.filter(({ fixture }) => fixture.synthetic);
		expect(
			new Set(syntheticFamilies.map(({ fixture }) => `${fixture.api}|${fixture.provider}|${fixture.model}`)),
		).toEqual(REQUIRED_SYNTHETIC_FAMILIES);

		resetApiProviders();
		const expectedCandidates = [...getCatalogProviderHandoffModels(), ...syntheticFamilies];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let expectedGroups: Map<string, ResolvedProviderHandoffFamily[]>;
		let manifestGroups: Map<string, ResolvedProviderHandoffFamily[]>;
		try {
			expectedGroups = await groupByFingerprint(expectedCandidates);
			manifestGroups = await groupByFingerprint(resolvedFamilies);
		} finally {
			errorSpy.mockRestore();
		}
		const duplicateManifestGroups = [...manifestGroups.values()].filter((group) => group.length > 1);
		const expectedFingerprints = [...expectedGroups.keys()].sort();
		const manifestFingerprints = [...manifestGroups.keys()].sort();
		const fingerprintsDiffer = JSON.stringify(manifestFingerprints) !== JSON.stringify(expectedFingerprints);
		const suggestedManifest = {
			schemaVersion: 1,
			families: [...expectedGroups.values()].map(([family]) => family.fixture),
		};
		if (
			(duplicateManifestGroups.length > 0 || fingerprintsDiffer) &&
			process.env.UPDATE_PROVIDER_HANDOFF_FAMILIES === "1"
		) {
			const fixtureUrl = new URL("./fixtures/provider-handoffs/v1/families.json", import.meta.url);
			writeFileSync(fixtureUrl, `${JSON.stringify(suggestedManifest, null, "\t")}\n`);
			return;
		}

		expect(duplicateManifestGroups).toEqual([]);
		if (fingerprintsDiffer) {
			throw new Error(
				`Provider handoff payload-family completeness failure. Suggested manifest:\n${JSON.stringify(suggestedManifest, null, 2)}`,
			);
		}
		expect(new Set(resolvedFamilies.map(({ model }) => model.api)).size).toBe(9);
	});
});

async function groupByFingerprint(
	families: ResolvedProviderHandoffFamily[],
): Promise<Map<string, ResolvedProviderHandoffFamily[]>> {
	const groups = new Map<string, ResolvedProviderHandoffFamily[]>();
	for (const family of families) {
		const fingerprint = await captureBehaviorFingerprint(family);
		const group = groups.get(fingerprint) ?? [];
		group.push(family);
		groups.set(fingerprint, group);
	}
	return groups;
}

async function captureBehaviorFingerprint(family: ResolvedProviderHandoffFamily): Promise<string> {
	const payloads: unknown[] = [];
	for (const reasoning of reasoningProfiles) {
		payloads.push(await capturePayload(family, reasoning));
	}

	const canonical = canonicalize(
		{
			api: family.model.api,
			provider: family.model.provider,
			explicitBranch: getExplicitBranch(family.model),
			payloads,
		},
		family.model.id,
	);
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function getExplicitBranch(model: Model<Api>): string | undefined {
	if (model.api !== "google-generative-ai" && model.api !== "google-vertex") return undefined;
	if (model.id.startsWith("claude-")) return "google-claude";
	if (model.id.startsWith("gpt-oss-")) return "google-gpt-oss";
	return undefined;
}

async function capturePayload(
	family: ResolvedProviderHandoffFamily,
	reasoning: SimpleStreamOptions["reasoning"],
): Promise<unknown> {
	const apiProvider = getApiProviders().find((provider) => provider.api === family.model.api);
	if (!apiProvider) throw new Error(`Missing API provider ${family.model.api}`);

	const context = createHandoffContext(sourceFixture, handoffFixtureFile.images, {
		api: sourceFixture.source.api,
		provider: "fixture-source-provider",
		model: "fixture-source-model",
	});
	context.tools = [inspectFixtureTool];
	let capturedPayload: unknown;
	resetTargetTransportAttempts();
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
		throw new Error("Network transport must not run in provider family fingerprinting");
	});

	try {
		const captureModel = {
			...family.model,
			baseUrl: createHermeticBaseUrl(family.model.baseUrl),
		} satisfies Model<Api>;
		const response = await apiProvider
			.streamSimple(captureModel, context, {
				apiKey: family.model.api === "openai-codex-responses" ? CODEX_FIXTURE_TOKEN : "fixture-key",
				cacheRetention: "long",
				maxTokens: 4_096,
				onPayload: (payload) => {
					capturedPayload = payload;
					throw new Error(PAYLOAD_CAPTURED);
				},
				reasoning,
				sessionId: "fixture-session",
				temperature: 0.2,
				...(family.model.api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
			})
			.result();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(getTargetTransportAttempts()).toEqual([]);
		expect(response.errorMessage).toContain(PAYLOAD_CAPTURED);
	} finally {
		fetchSpy.mockRestore();
	}

	if (capturedPayload === undefined) {
		throw new Error(`Provider family did not expose a payload: ${family.fixture.provider}/${family.fixture.model}`);
	}
	return capturedPayload;
}

function getCanonicalSourceFixture() {
	const fixture = handoffFixtureFile.fixtures.find((candidate) => candidate.source.api === "anthropic-messages");
	if (!fixture) throw new Error("Missing canonical Anthropic handoff fixture");
	return fixture;
}

function createHermeticBaseUrl(baseUrl: string): string {
	if (!baseUrl) return HERMETIC_BASE_URL;
	return baseUrl.replace(/\{[A-Z_][A-Z0-9_]*\}/g, "fixture");
}

function canonicalize(value: unknown, modelId: string): unknown {
	if (typeof value === "string") return value.split(modelId).join("<model-id>");
	if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
	if (Array.isArray(value)) return value.map((item) => canonicalize(item, modelId));
	if (typeof value !== "object" || value === null) return value;

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const child = (value as Record<string, unknown>)[key];
		if (child !== undefined) result[key] = canonicalize(child, modelId);
	}
	return result;
}
