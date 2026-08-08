import type { ClientRequest } from "node:http";
import { ProxyAgent } from "proxy-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
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
});

import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context, Model } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalAwsRegion = process.env.AWS_REGION;
const originalAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
const originalAwsProfile = process.env.AWS_PROFILE;
const proxyEnvKeys = [
	"ALL_PROXY",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"all_proxy",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;
const originalProxyEnv = new Map(proxyEnvKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
	bedrockMock.constructorCalls.length = 0;
	delete process.env.AWS_REGION;
	delete process.env.AWS_DEFAULT_REGION;
	delete process.env.AWS_PROFILE;
	for (const key of proxyEnvKeys) {
		delete process.env[key];
	}
});

afterEach(() => {
	if (originalAwsRegion === undefined) {
		delete process.env.AWS_REGION;
	} else {
		process.env.AWS_REGION = originalAwsRegion;
	}

	if (originalAwsDefaultRegion === undefined) {
		delete process.env.AWS_DEFAULT_REGION;
	} else {
		process.env.AWS_DEFAULT_REGION = originalAwsDefaultRegion;
	}

	if (originalAwsProfile === undefined) {
		delete process.env.AWS_PROFILE;
	} else {
		process.env.AWS_PROFILE = originalAwsProfile;
	}

	for (const key of proxyEnvKeys) {
		const originalValue = originalProxyEnv.get(key);
		if (originalValue === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = originalValue;
		}
	}
});

async function captureClientConfig(model: Model<"bedrock-converse-stream">): Promise<Record<string, unknown>> {
	await streamBedrock(model, context, { cacheRetention: "none" }).result();
	expect(bedrockMock.constructorCalls).toHaveLength(1);
	return bedrockMock.constructorCalls[0];
}

describe("bedrock endpoint resolution", () => {
	it("assigns eu-central-1 runtime URLs to built-in EU inference profiles", () => {
		const model = getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		expect(model.baseUrl).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
	});

	it("does not pin standard AWS endpoints when AWS_REGION is configured", async () => {
		process.env.AWS_REGION = "us-east-2";
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7");

		const config = await captureClientConfig(model);

		expect(config.region).toBe("us-east-2");
		expect(config.endpoint).toBeUndefined();
	});

	it("derives region from a built-in EU endpoint when no region or profile is configured", async () => {
		const model = getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
		expect(config.region).toBe("eu-central-1");
	});

	it("still passes custom Bedrock endpoints through to the SDK client", async () => {
		process.env.AWS_REGION = "us-west-2";
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			baseUrl: "https://bedrock-vpc.example.com",
		};

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-vpc.example.com");
		expect(config.region).toBe("us-west-2");
	});
});

interface InspectableNodeHttpHandler {
	metadata?: { handlerProtocol?: string };
	configProvider?: Promise<{ httpsAgent?: ProxyAgent }>;
}

describe("bedrock proxy resolution", () => {
	it.each([
		{
			name: "HTTP",
			envKey: "HTTP_PROXY" as const,
			proxyUrl: "http://127.0.0.1:8080",
			requestUrl: "http://bedrock-vpc.example.com",
		},
		{
			name: "SOCKS",
			envKey: "HTTPS_PROXY" as const,
			proxyUrl: "socks5://127.0.0.1:1080",
			requestUrl: "https://bedrock-vpc.example.com",
		},
	])("uses the configured $name proxy through the HTTP/1.1 handler", async ({ envKey, proxyUrl, requestUrl }) => {
		process.env[envKey] = proxyUrl;
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			baseUrl: requestUrl,
		};

		const config = await captureClientConfig(model);
		const requestHandler = config.requestHandler as unknown as InspectableNodeHttpHandler;
		const handlerConfig = await requestHandler.configProvider;
		const agent = handlerConfig?.httpsAgent;

		expect(requestHandler.metadata?.handlerProtocol).toBe("http/1.1");
		expect(agent).toBeInstanceOf(ProxyAgent);
		expect(await agent?.getProxyForUrl(requestUrl, {} as ClientRequest)).toBe(proxyUrl);
	});
});
