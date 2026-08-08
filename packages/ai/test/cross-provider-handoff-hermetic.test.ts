import { Buffer } from "node:buffer";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getApiProviders } from "../src/api-registry.js";
import { resetApiProviders } from "../src/providers/register-builtins.js";
import type { Api, Model, StreamOptions, Tool } from "../src/types.js";
import {
	loadProviderHandoffFamilyFile,
	type ResolvedProviderHandoffFamily,
	resolveProviderHandoffFamilies,
} from "./provider-handoff-families.js";
import {
	createHandoffContext,
	type HandoffApi,
	loadProviderHandoffFixtureFile,
	parseProviderHandoffFixtureFile,
} from "./provider-handoff-fixtures.js";
import { getTargetTransportAttempts, resetTargetTransportAttempts } from "./provider-handoff-target-transport.js";

const fixtureFile = loadProviderHandoffFixtureFile();
const protocolFixtures = new Map(fixtureFile.fixtures.map((fixture) => [fixture.source.api, fixture]));
const resolvedFamilies = resolveProviderHandoffFamilies(loadProviderHandoffFamilyFile());
const fixturePairs = resolvedFamilies.flatMap((source) => resolvedFamilies.map((target) => ({ source, target })));

const inspectFixtureTool: Tool = {
	name: "inspect_fixture",
	description: "Inspect a sanitized fixture path.",
	parameters: Type.Object({ path: Type.String() }),
};

const CODEX_FIXTURE_TOKEN =
	"e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9maXh0dXJlIn19.fixture";
const HERMETIC_BASE_URL = "http://127.0.0.1:9";
const PAYLOAD_CAPTURED = "provider handoff payload captured";
const APIS_WITHOUT_REPLAYED_TOOL_IDS = new Set<HandoffApi>(["google-generative-ai", "google-vertex"]);
const APIS_WITH_EXPLICIT_TOOL_ERRORS = new Set<HandoffApi>([
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
]);

interface PayloadInspection {
	toolCallIds: string[];
	toolResultIds: string[];
	responseItemIds: string[];
	toolCallNames: string[];
	toolResultNames: string[];
	imageData: string[];
	imageCount: number;
	hasExplicitToolError: boolean;
}

let expectedProviderErrorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
	expectedProviderErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
	expectedProviderErrorSpy.mockRestore();
});

describe("hermetic cross-provider handoff contract", () => {
	it("parses, validates, and serializes the versioned fixtures deterministically", () => {
		const serialized = JSON.stringify(fixtureFile);
		const reparsed = parseProviderHandoffFixtureFile(serialized);

		expect(reparsed).toEqual(fixtureFile);
		expect(JSON.stringify(reparsed)).toBe(serialized);
		expect(() =>
			parseProviderHandoffFixtureFile(serialized.replace('"schemaVersion":1', '"schemaVersion":2')),
		).toThrow("schema validation");
		expect(serialized).not.toMatch(/(?:api[_-]?key|authorization|bearer|secret|sk-[a-z0-9])/i);
		expect(fixtureFile.coverage).toEqual({
			userImages: true,
			toolResultImages: true,
			toolErrors: true,
			providerErrors: true,
		});
	});

	it("requires one fixture for every registered built-in API", () => {
		resetApiProviders();
		const fixtureApis = [...new Set(fixtureFile.fixtures.map((fixture) => fixture.source.api))].sort();
		const registeredApis = getApiProviders()
			.map((provider) => provider.api)
			.sort();

		expect(fixtureApis).toEqual(registeredApis);
	});

	it.each(fixturePairs)(
		"converts $source.fixture.provider/$source.fixture.model history for $target.fixture.provider/$target.fixture.model without transport",
		async ({ source, target }) => {
			resetTargetTransportAttempts();
			expect(getTargetTransportAttempts()).toEqual([]);
			resetApiProviders();
			const apiProvider = getApiProviders().find((provider) => provider.api === target.model.api);
			expect(apiProvider).toBeDefined();
			if (!apiProvider) throw new Error(`Missing API provider ${target.model.api}`);
			const sourceProtocol = protocolFixtures.get(source.model.api as HandoffApi);
			expect(sourceProtocol).toBeDefined();
			if (!sourceProtocol) throw new Error(`Missing protocol fixture ${source.model.api}`);

			let capturedPayload: unknown;
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
				throw new Error("Network transport must not run in hermetic handoff tests");
			});

			try {
				const context = createHandoffContext(sourceProtocol, fixtureFile.images, {
					api: source.model.api as HandoffApi,
					provider: source.model.provider,
					model: source.model.id,
				});
				context.tools = [inspectFixtureTool];
				const response = await apiProvider
					.stream(
						createTargetModel(target),
						context,
						createCaptureOptions(target.model.api, (payload) => {
							capturedPayload = payload;
							throw new Error(PAYLOAD_CAPTURED);
						}),
					)
					.result();

				expect(fetchSpy).not.toHaveBeenCalled();
				expect(getTargetTransportAttempts()).toEqual([]);
				expect(response.stopReason).toBe("error");
				expect(response.errorMessage).toContain(PAYLOAD_CAPTURED);
			} finally {
				fetchSpy.mockRestore();
			}

			expect(capturedPayload).toBeDefined();
			const serializedPayload = JSON.stringify(capturedPayload);
			expect(() => JSON.parse(serializedPayload)).not.toThrow();
			expect(serializedPayload).toContain("fixture tool failure");
			expect(serializedPayload).not.toContain("fixture provider error");
			expect(serializedPayload).not.toContain("Partial output from a failed provider response.");
			expect(serializedPayload).toContain("Sanitized provider reasoning summary.");

			const targetApi = target.model.api as HandoffApi;
			const inspection = inspectPayload(targetApi, capturedPayload);
			if (target.model.input.includes("image")) {
				expect(inspection.imageData).toContain(fixtureFile.images.user.data);
				expect(inspection.imageData).toContain(fixtureFile.images.toolResult.data);
				expect(inspection.imageCount).toBe(2);
			} else {
				expect(inspection.imageCount).toBe(0);
				expect(inspection.imageData).toEqual([]);
				expect(serializedPayload).toContain("(image omitted: model does not support images)");
				expect(serializedPayload).toContain("(tool image omitted: model does not support images)");
			}
			expect(inspection.hasExplicitToolError).toBe(APIS_WITH_EXPLICIT_TOOL_ERRORS.has(targetApi));
			expect(inspection.toolCallNames).toEqual(["inspect_fixture"]);
			if (targetApi === "google-generative-ai" || targetApi === "google-vertex") {
				expect(inspection.toolResultNames).toEqual(["inspect_fixture"]);
			}

			const googleRequiresIds =
				(targetApi === "google-generative-ai" || targetApi === "google-vertex") &&
				(target.model.id.startsWith("claude-") || target.model.id.startsWith("gpt-oss-"));
			if (APIS_WITHOUT_REPLAYED_TOOL_IDS.has(targetApi) && !googleRequiresIds) {
				expect(inspection.toolCallIds).toEqual([]);
				expect(inspection.toolResultIds).toEqual([]);
			} else {
				expect(inspection.toolCallIds).toHaveLength(1);
				expect(inspection.toolResultIds).toEqual(inspection.toolCallIds);
			}
			assertNativeToolIdContract(target, inspection);
			if (
				(targetApi === "azure-openai-responses" ||
					targetApi === "openai-codex-responses" ||
					targetApi === "openai-responses") &&
				["azure-openai-responses", "openai", "openai-codex", "opencode"].includes(target.model.provider) &&
				source.model.id === target.model.id &&
				sourceProtocol.protocol.toolCallId.includes("|")
			) {
				expect(inspection.responseItemIds).toHaveLength(1);
			}

			const isRoundTrip =
				source.model.api === target.model.api &&
				source.model.provider === target.model.provider &&
				source.model.id === target.model.id;
			const thinkingSignature = sourceProtocol.protocol.thinkingSignature;
			if (thinkingSignature && thinkingSignature !== "reasoning_content") {
				const targetSupportsThinkingSignature =
					targetApi !== "bedrock-converse-stream" || target.model.id.includes("anthropic.claude");
				expect(serializedPayload.includes(getThinkingSignatureMarker(thinkingSignature))).toBe(
					isRoundTrip && targetSupportsThinkingSignature,
				);
			}
			const toolThoughtSignature = sourceProtocol.protocol.toolThoughtSignature;
			if (toolThoughtSignature) {
				expect(serializedPayload.includes(getToolThoughtSignatureMarker(toolThoughtSignature))).toBe(isRoundTrip);
			}
		},
	);
});

function createTargetModel(family: ResolvedProviderHandoffFamily): Model<Api> {
	return {
		...family.model,
		baseUrl: HERMETIC_BASE_URL,
	};
}

function assertNativeToolIdContract(target: ResolvedProviderHandoffFamily, inspection: PayloadInspection): void {
	const api = target.model.api as HandoffApi;
	for (const id of [...inspection.toolCallIds, ...inspection.toolResultIds]) {
		expect(id).not.toContain("|");
	}

	switch (api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
			for (const id of inspection.toolCallIds) {
				expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
			}
			break;
		case "mistral-conversations":
			expect(inspection.toolCallIds[0]).toMatch(/^[A-Za-z0-9]{9}$/);
			break;
		case "azure-openai-responses":
		case "openai-codex-responses":
		case "openai-responses":
			for (const id of inspection.toolCallIds) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
			for (const id of inspection.responseItemIds) {
				expect(id).toMatch(/^fc_[A-Za-z0-9_-]{1,61}$/);
			}
			break;
		case "google-generative-ai":
		case "google-vertex":
			for (const id of inspection.toolCallIds) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
			break;
		case "openai-completions":
			if (target.model.provider === "openai") {
				for (const id of inspection.toolCallIds) expect(id.length).toBeLessThanOrEqual(40);
			}
			break;
	}
}

function getThinkingSignatureMarker(signature: string): string {
	if (!signature.startsWith("{")) return signature;
	const parsed = JSON.parse(signature) as { encrypted_content?: unknown };
	if (typeof parsed.encrypted_content !== "string") {
		throw new Error("Fixture reasoning signature lacks encrypted_content marker");
	}
	return parsed.encrypted_content;
}

function getToolThoughtSignatureMarker(signature: string): string {
	if (!signature.startsWith("{")) return signature;
	const parsed = JSON.parse(signature) as { data?: unknown };
	if (typeof parsed.data !== "string") throw new Error("Fixture tool signature lacks data marker");
	return parsed.data;
}

function createCaptureOptions(api: Api, onPayload: NonNullable<StreamOptions["onPayload"]>): StreamOptions {
	return {
		apiKey: api === "openai-codex-responses" ? CODEX_FIXTURE_TOKEN : "fixture-key",
		onPayload,
		...(api === "openai-codex-responses" ? { transport: "sse" as const } : {}),
	};
}

function inspectPayload(api: HandoffApi, payload: unknown): PayloadInspection {
	const inspection: PayloadInspection = {
		toolCallIds: [],
		toolResultIds: [],
		responseItemIds: [],
		toolCallNames: [],
		toolResultNames: [],
		imageData: [],
		imageCount: 0,
		hasExplicitToolError: false,
	};

	visit(payload, (record) => {
		const imageData = extractImageData(record);
		if (imageData !== undefined) {
			inspection.imageCount++;
			inspection.imageData.push(imageData);
		}

		switch (api) {
			case "anthropic-messages":
				if (record.type === "tool_use" && typeof record.id === "string") {
					inspection.toolCallIds.push(record.id);
					if (typeof record.name === "string") inspection.toolCallNames.push(record.name);
				}
				if (record.type === "tool_result" && typeof record.tool_use_id === "string") {
					inspection.toolResultIds.push(record.tool_use_id);
					inspection.hasExplicitToolError ||= record.is_error === true;
				}
				break;
			case "bedrock-converse-stream": {
				const toolUse = record.toolUse;
				if (isRecord(toolUse) && typeof toolUse.toolUseId === "string") {
					inspection.toolCallIds.push(toolUse.toolUseId);
					if (typeof toolUse.name === "string") inspection.toolCallNames.push(toolUse.name);
				}
				const toolResult = record.toolResult;
				if (isRecord(toolResult) && typeof toolResult.toolUseId === "string") {
					inspection.toolResultIds.push(toolResult.toolUseId);
					inspection.hasExplicitToolError ||= toolResult.status === "error";
				}
				break;
			}
			case "google-generative-ai":
			case "google-vertex": {
				const functionCall = record.functionCall;
				if (isRecord(functionCall) && typeof functionCall.id === "string") {
					inspection.toolCallIds.push(functionCall.id);
				}
				if (isRecord(functionCall) && typeof functionCall.name === "string") {
					inspection.toolCallNames.push(functionCall.name);
				}
				const functionResponse = record.functionResponse;
				if (isRecord(functionResponse)) {
					if (typeof functionResponse.id === "string") inspection.toolResultIds.push(functionResponse.id);
					if (typeof functionResponse.name === "string") inspection.toolResultNames.push(functionResponse.name);
					const response = functionResponse.response;
					inspection.hasExplicitToolError ||= isRecord(response) && typeof response.error === "string";
				}
				break;
			}
			case "mistral-conversations": {
				if (Array.isArray(record.toolCalls)) {
					for (const toolCall of record.toolCalls) {
						if (!isRecord(toolCall)) continue;
						if (typeof toolCall.id === "string") inspection.toolCallIds.push(toolCall.id);
						const fn = toolCall.function;
						if (isRecord(fn) && typeof fn.name === "string") inspection.toolCallNames.push(fn.name);
					}
				}
				if (record.role === "tool" && typeof record.toolCallId === "string") {
					inspection.toolResultIds.push(record.toolCallId);
					if (typeof record.name === "string") inspection.toolResultNames.push(record.name);
					inspection.hasExplicitToolError ||= JSON.stringify(record.content).includes("[tool error]");
				}
				break;
			}
			case "openai-completions":
				if (Array.isArray(record.tool_calls)) {
					for (const toolCall of record.tool_calls) {
						if (!isRecord(toolCall)) continue;
						if (typeof toolCall.id === "string") inspection.toolCallIds.push(toolCall.id);
						const fn = toolCall.function;
						if (isRecord(fn) && typeof fn.name === "string") inspection.toolCallNames.push(fn.name);
					}
				}
				if (record.role === "tool" && typeof record.tool_call_id === "string") {
					inspection.toolResultIds.push(record.tool_call_id);
				}
				break;
			case "azure-openai-responses":
			case "openai-codex-responses":
			case "openai-responses":
				if (record.type === "function_call" && typeof record.call_id === "string") {
					inspection.toolCallIds.push(record.call_id);
					if (typeof record.id === "string") inspection.responseItemIds.push(record.id);
					if (typeof record.name === "string") inspection.toolCallNames.push(record.name);
				}
				if (record.type === "function_call_output" && typeof record.call_id === "string") {
					inspection.toolResultIds.push(record.call_id);
				}
				break;
		}
	});

	return inspection;
}

function extractImageData(record: Record<string, unknown>): string | undefined {
	if (isRecord(record.inlineData) && typeof record.inlineData.data === "string") {
		return record.inlineData.data;
	}

	if (record.type === "image" && isRecord(record.source) && typeof record.source.data === "string") {
		return record.source.data;
	}

	if (record.type === "image_url" && typeof record.imageUrl === "string") {
		return stripDataUrl(record.imageUrl);
	}

	if (record.type === "image_url" && isRecord(record.image_url) && typeof record.image_url.url === "string") {
		return stripDataUrl(record.image_url.url);
	}

	if (record.type === "input_image" && typeof record.image_url === "string") {
		return stripDataUrl(record.image_url);
	}

	if (isRecord(record.image) && isRecord(record.image.source)) {
		const bytes = record.image.source.bytes;
		if (bytes instanceof Uint8Array) return Buffer.from(bytes).toString("base64");
	}

	return undefined;
}

function stripDataUrl(value: string): string {
	const separator = value.indexOf(",");
	return separator === -1 ? value : value.slice(separator + 1);
}

function visit(value: unknown, callback: (record: Record<string, unknown>) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) visit(item, callback);
		return;
	}
	if (!isRecord(value)) return;
	callback(value);
	for (const child of Object.values(value)) visit(child, callback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
