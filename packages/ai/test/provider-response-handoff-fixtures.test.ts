import { beforeEach, describe, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({
	events: [] as unknown[],
	calls: 0,
}));

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		messages = {
			create: () => ({
				asResponse: async () => {
					transportMock.calls++;
					const body = transportMock.events
						.map((entry) => {
							const event = entry as { event: string; data: unknown };
							return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
						})
						.join("");
					return new Response(body, { status: 200, headers: { "request-id": "req_fixture" } });
				},
			}),
		};
	}
	return { default: FakeAnthropic };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	class BedrockRuntimeClient {
		async send() {
			transportMock.calls++;
			return {
				$metadata: { httpStatusCode: 200, requestId: "req_fixture_bedrock" },
				stream: createAsyncIterable(transportMock.events),
			};
		}
	}
	class ConverseStreamCommand {
		constructor(readonly input: unknown) {}
	}
	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};

	function createAsyncIterable(events: unknown[]) {
		return {
			async *[Symbol.asyncIterator]() {
				for (const event of events) yield event;
			},
		};
	}
});

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async () => {
				transportMock.calls++;
				return createAsyncIterable(transportMock.events);
			},
		};
	}
	return {
		GoogleGenAI,
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			SAFETY: "SAFETY",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			RECITATION: "RECITATION",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			OTHER: "OTHER",
			LANGUAGE: "LANGUAGE",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};

	function createAsyncIterable(events: unknown[]) {
		return {
			async *[Symbol.asyncIterator]() {
				for (const event of events) yield event;
			},
		};
	}
});

vi.mock("@mistralai/mistralai", () => {
	class Mistral {
		chat = {
			stream: async () => {
				transportMock.calls++;
				return createAsyncIterable(transportMock.events);
			},
		};
	}
	return { Mistral };

	function createAsyncIterable(events: unknown[]) {
		return {
			async *[Symbol.asyncIterator]() {
				for (const event of events) yield event;
			},
		};
	}
});

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = { completions: { create: () => createResponsePromise() } };
		responses = { create: () => createResponsePromise() };
	}

	class FakeAzureOpenAI extends FakeOpenAI {}

	return { default: FakeOpenAI, AzureOpenAI: FakeAzureOpenAI };

	function createResponsePromise() {
		transportMock.calls++;
		const stream = {
			async *[Symbol.asyncIterator]() {
				for (const event of transportMock.events) yield event;
			},
		};
		return Object.assign(Promise.resolve(stream), {
			withResponse: async () => ({
				data: stream,
				response: { status: 200, headers: new Headers({ "x-request-id": "req_fixture" }) },
			}),
		});
	}
});

import { getApiProviders } from "../src/api-registry.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import { streamGoogle } from "../src/providers/google.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import { streamMistral } from "../src/providers/mistral.js";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import { resetApiProviders } from "../src/providers/register-builtins.js";
import type { Api, AssistantMessageEventStream, Context, Model, StreamOptions } from "../src/types.js";
import {
	assertProviderResponseFixtureApiCompleteness,
	loadProviderResponseFixtureFile,
	type ProviderResponseFixture,
	parseProviderResponseFixtureFile,
} from "./provider-response-handoff-fixtures.js";

const fixtureFile = loadProviderResponseFixtureFile();
const HERMETIC_BASE_URL = "http://127.0.0.1:9";
const CODEX_FIXTURE_TOKEN =
	"e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9maXh0dXJlIn19.fixture";
const context: Context = {
	messages: [{ role: "user", content: "Replay the raw response fixture.", timestamp: 1_700_000_000_000 }],
};

beforeEach(() => {
	transportMock.events = [];
	transportMock.calls = 0;
});

describe("provider response handoff fixtures", () => {
	it("validates and deterministically serializes versioned raw provider responses", () => {
		const serialized = JSON.stringify(fixtureFile);
		expect(JSON.stringify(parseProviderResponseFixtureFile(serialized))).toBe(serialized);
		expect(() =>
			parseProviderResponseFixtureFile(serialized.replace('"schemaVersion":1', '"schemaVersion":2')),
		).toThrow("schema validation");
	});

	it("rejects raw fixtures containing auth material or unsanitized provider IDs", () => {
		const serialized = JSON.stringify(fixtureFile);
		expect(() =>
			parseProviderResponseFixtureFile(
				serialized.replace('"type":"message_start"', '"type":"message_start","authorization":"Bearer live-secret"'),
			),
		).toThrow("sanitization");
		expect(() =>
			parseProviderResponseFixtureFile(serialized.replace("req_fixture_anthropic", "req_live_4f8a62b5")),
		).toThrow("sanitization");

		for (const key of [
			"x-api-key",
			"api_token",
			"client_secret",
			"auth_token",
			"id_token",
			"refresh_token",
			"password",
			"private_key",
			"secret_key",
			"secret_access_key",
			"credential",
			"credentials",
			"token",
		]) {
			expect(() =>
				parseProviderResponseFixtureFile(
					serialized.replace('"type":"message_start"', `"type":"message_start","${key}":"live-credential"`),
				),
			).toThrow("sanitization");
		}
		expect(() =>
			parseProviderResponseFixtureFile(serialized.replace("resp_fixture_google", "resp_live_google_4f8a62b5")),
		).toThrow("sanitization");
		expect(() =>
			parseProviderResponseFixtureFile(
				serialized.replace(
					'"type":"message_start"',
					'"type":"message_start","providerRequestId":"req_live_provider_4f8a62b5"',
				),
			),
		).toThrow("sanitization");
		expect(() =>
			parseProviderResponseFixtureFile(serialized.replace("msg_fixture_anthropic", "msg_live_anthropic_4f8a62b5")),
		).toThrow("sanitization");
		expect(() =>
			parseProviderResponseFixtureFile(serialized.replace("resp_fixture_openai", "resp_live_openai_4f8a62b5")),
		).toThrow("sanitization");
	});

	it("requires exactly one raw parser fixture for every registered built-in API", () => {
		resetApiProviders();
		const registeredApis = getApiProviders().map((provider) => provider.api);
		expect(() => assertProviderResponseFixtureApiCompleteness(fixtureFile, registeredApis)).not.toThrow();
		expect(() =>
			assertProviderResponseFixtureApiCompleteness(
				{ ...fixtureFile, responses: fixtureFile.responses.slice(1) },
				registeredApis,
			),
		).toThrow("completeness");
	});

	it.each(fixtureFile.responses)("parses $id through its production source stream", async (fixture) => {
		const message = await replayFixture(fixture, fixture.success);

		expect(transportMock.calls).toBe(1);
		expect(message.stopReason).toBe("toolUse");
		const thinking = message.content.find((block) => block.type === "thinking");
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(thinking?.thinking).toContain(fixture.expected.thinkingText);
		if (fixture.expected.thinkingSignatureMarker === null) {
			expect(thinking?.thinkingSignature).toBeUndefined();
		} else {
			expect(thinking?.thinkingSignature).toContain(fixture.expected.thinkingSignatureMarker);
		}
		expect(toolCall?.id).toBe(fixture.expected.toolCallId);
		expect(toolCall?.arguments).toEqual({ path: "raw.txt" });
		if (fixture.expected.toolThoughtSignatureMarker !== null) {
			expect(toolCall?.thoughtSignature).toContain(fixture.expected.toolThoughtSignatureMarker);
		}
	});

	it.each(fixtureFile.responses)("parses $id provider errors without transport", async (fixture) => {
		const message = await replayFixture(fixture, fixture.error);

		expect(transportMock.calls).toBe(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain(fixture.expected.errorMarker);
	});
});

async function replayFixture(fixture: ProviderResponseFixture, events: unknown[]) {
	transportMock.events = events;
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		if (fixture.api !== "openai-codex-responses") {
			throw new Error(`Unexpected fetch transport for ${fixture.api}`);
		}
		transportMock.calls++;
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	try {
		return await createFixtureStream(fixture).result();
	} finally {
		if (fixture.api === "openai-codex-responses") {
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} else {
			expect(fetchSpy).not.toHaveBeenCalled();
		}
		fetchSpy.mockRestore();
	}
}

function createFixtureStream(fixture: ProviderResponseFixture): AssistantMessageEventStream {
	const model = createFixtureModel(fixture);
	const options: StreamOptions = {
		apiKey: fixture.api === "openai-codex-responses" ? CODEX_FIXTURE_TOKEN : "fixture-key",
		transport: "sse",
		cacheRetention: "none",
	};

	switch (fixture.api) {
		case "anthropic-messages":
			return streamAnthropic(model as Model<"anthropic-messages">, context, options);
		case "azure-openai-responses":
			return streamAzureOpenAIResponses(model as Model<"azure-openai-responses">, context, options);
		case "bedrock-converse-stream":
			return streamBedrock(model as Model<"bedrock-converse-stream">, context, options);
		case "google-generative-ai":
			return streamGoogle(model as Model<"google-generative-ai">, context, options);
		case "google-vertex":
			return streamGoogleVertex(model as Model<"google-vertex">, context, options);
		case "mistral-conversations":
			return streamMistral(model as Model<"mistral-conversations">, context, options);
		case "openai-codex-responses":
			return streamOpenAICodexResponses(model as Model<"openai-codex-responses">, context, options);
		case "openai-completions":
			return streamOpenAICompletions(model as Model<"openai-completions">, context, options);
		case "openai-responses":
			return streamOpenAIResponses(model as Model<"openai-responses">, context, options);
	}
}

function createFixtureModel(fixture: ProviderResponseFixture): Model<Api> {
	const metadata = {
		"anthropic-messages": { provider: "anthropic", model: "claude-sonnet-4-5" },
		"azure-openai-responses": { provider: "azure-openai-responses", model: "gpt-5-mini" },
		"bedrock-converse-stream": {
			provider: "amazon-bedrock",
			model: "anthropic.claude-3-7-sonnet-20250219-v1:0",
		},
		"google-generative-ai": { provider: "google", model: "gemini-3-flash-preview" },
		"google-vertex": { provider: "google-vertex", model: "gemini-3-flash-preview" },
		"mistral-conversations": { provider: "mistral", model: "devstral-medium-latest" },
		"openai-codex-responses": { provider: "openai-codex", model: "gpt-5.2-codex" },
		"openai-completions": { provider: "openai", model: "gpt-5-mini" },
		"openai-responses": { provider: "openai", model: "gpt-5-mini" },
	}[fixture.api];

	return {
		id: metadata.model,
		name: `Raw fixture ${fixture.api}`,
		api: fixture.api,
		provider: metadata.provider,
		baseUrl: HERMETIC_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4_096,
	};
}
