import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({
	clientConfigs: [] as Array<Record<string, unknown>>,
	handlerOptions: [] as unknown[],
	proxyAgents: [] as object[],
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			transportMock.clientConfigs.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {}

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

vi.mock("@smithy/node-http-handler", () => ({
	NodeHttpHandler: class {
		constructor(options?: unknown) {
			transportMock.handlerOptions.push(options);
		}
	},
}));

vi.mock("proxy-agent", () => ({
	ProxyAgent: class {
		constructor() {
			transportMock.proxyAgents.push(this);
		}
	},
}));

import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context, Model } from "../src/types.js";

const ENV_KEYS = [
	"AWS_BEDROCK_FORCE_HTTP1",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};
const model: Model<"bedrock-converse-stream"> = {
	id: "test-model",
	name: "Test model",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 128,
};

beforeEach(() => {
	transportMock.clientConfigs.length = 0;
	transportMock.handlerOptions.length = 0;
	transportMock.proxyAgents.length = 0;
	for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function captureClientConfig(): Promise<Record<string, unknown>> {
	await streamBedrock(model, context, { region: "us-east-1" }).result();
	expect(transportMock.clientConfigs).toHaveLength(1);
	return transportMock.clientConfigs[0];
}

describe("Bedrock Node transport selection", () => {
	it("uses a statically imported Node HTTP/1 handler when forced", async () => {
		process.env.AWS_BEDROCK_FORCE_HTTP1 = "1";

		const config = await captureClientConfig();

		expect(transportMock.handlerOptions).toEqual([undefined]);
		expect(transportMock.proxyAgents).toHaveLength(0);
		expect(config.requestHandler).toBeDefined();
	});

	it("configures the Node HTTP/1 handler with one proxy agent for both protocols", async () => {
		process.env.HTTPS_PROXY = "http://proxy.example.test:8080";
		process.env.AWS_BEDROCK_FORCE_HTTP1 = "1";

		const config = await captureClientConfig();

		expect(transportMock.proxyAgents).toHaveLength(1);
		expect(transportMock.handlerOptions).toEqual([
			{
				httpAgent: transportMock.proxyAgents[0],
				httpsAgent: transportMock.proxyAgents[0],
			},
		]);
		expect(config.requestHandler).toBeDefined();
	});

	it("leaves the SDK default transport unchanged without proxy or force configuration", async () => {
		const config = await captureClientConfig();

		expect(transportMock.handlerOptions).toHaveLength(0);
		expect(transportMock.proxyAgents).toHaveLength(0);
		expect(config.requestHandler).toBeUndefined();
	});
});
