import { once } from "node:events";
import {
	createServer as createHttpServer,
	type Agent as HttpAgent,
	type Server as HttpServer,
	get as httpGet,
	request as httpRequest,
} from "node:http";
import { connect as connectTcp, createServer as createNetServer, type Server as NetServer } from "node:net";
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
	configProvider?: Promise<{
		httpAgentProvider?: () => Promise<HttpAgent>;
		httpsAgent?: HttpAgent;
	}>;
}

type LoopbackServer = HttpServer | NetServer;

interface SocksConnectObservation {
	addressType: "domain" | "ipv4";
	host: string;
	port: number;
}

async function listenOnLoopback(server: LoopbackServer): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Loopback server did not bind to a TCP port");
	}
	return address.port;
}

async function closeServer(server: LoopbackServer): Promise<void> {
	if (!server.listening) return;
	server.close();
	await once(server, "close");
}

function createTargetServer(): HttpServer {
	return createHttpServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain", connection: "close" });
		response.end("bedrock-loopback-ok");
	});
}

function createHttpProxyServer(requestUrls: string[]): HttpServer {
	return createHttpServer((request, response) => {
		if (request.url === undefined) {
			response.writeHead(400).end();
			return;
		}

		requestUrls.push(request.url);
		const target = new URL(request.url);
		const upstream = httpRequest(
			target,
			{
				agent: false,
				headers: { ...request.headers, connection: "close", host: target.host },
				method: request.method,
			},
			(upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			},
		);
		upstream.once("error", (error) => response.destroy(error));
		request.pipe(upstream);
	});
}

function createSocks5ProxyServer(observations: SocksConnectObservation[]): NetServer {
	return createNetServer((client) => {
		let buffer = Buffer.alloc(0);
		let stage: "greeting" | "request" | "connecting" = "greeting";

		client.on("error", () => {});
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);

			if (stage === "greeting") {
				if (buffer.length < 2) return;
				const greetingLength = 2 + buffer[1];
				if (buffer.length < greetingLength) return;
				const methods = buffer.subarray(2, greetingLength);
				if (buffer[0] !== 0x05 || !methods.includes(0x00)) {
					client.end(Buffer.from([0x05, 0xff]));
					return;
				}
				buffer = buffer.subarray(greetingLength);
				stage = "request";
				client.write(Buffer.from([0x05, 0x00]));
			}

			if (stage !== "request" || buffer.length < 5) return;
			if (buffer[0] !== 0x05 || buffer[1] !== 0x01 || buffer[2] !== 0x00) {
				client.destroy(new Error("Unsupported SOCKS5 request"));
				return;
			}

			const addressType = buffer[3];
			let host: string;
			let portOffset: number;
			let observedAddressType: SocksConnectObservation["addressType"];
			if (addressType === 0x01) {
				portOffset = 8;
				if (buffer.length < portOffset + 2) return;
				host = Array.from(buffer.subarray(4, portOffset)).join(".");
				observedAddressType = "ipv4";
			} else if (addressType === 0x03) {
				const hostLength = buffer[4];
				portOffset = 5 + hostLength;
				if (buffer.length < portOffset + 2) return;
				host = buffer.toString("utf8", 5, portOffset);
				observedAddressType = "domain";
			} else {
				client.destroy(new Error(`Unsupported SOCKS5 address type: ${addressType}`));
				return;
			}

			const requestLength = portOffset + 2;
			const port = buffer.readUInt16BE(portOffset);
			const pendingPayload = buffer.subarray(requestLength);
			buffer = Buffer.alloc(0);
			stage = "connecting";
			observations.push({ addressType: observedAddressType, host, port });

			if (host !== "127.0.0.1" && host !== "localhost") {
				client.destroy(new Error(`Refusing non-loopback SOCKS5 destination: ${host}`));
				return;
			}

			const upstream = connectTcp({ host: "127.0.0.1", port });
			upstream.once("connect", () => {
				client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
				client.removeListener("data", onData);
				if (pendingPayload.length > 0) upstream.write(pendingPayload);
				client.pipe(upstream);
				upstream.pipe(client);
			});
			upstream.once("error", (error) => client.destroy(error));
			client.once("close", () => upstream.destroy());
		};

		client.on("data", onData);
	});
}

async function requestText(url: string, agent: ProxyAgent): Promise<{ body: string; statusCode: number }> {
	return await new Promise((resolvePromise, reject) => {
		const request = httpGet(url, { agent }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("end", () => {
				resolvePromise({
					body: Buffer.concat(chunks).toString("utf8"),
					statusCode: response.statusCode ?? 0,
				});
			});
		});
		request.once("error", reject);
	});
}

async function captureBedrockProxyAgent(requestUrl: string): Promise<ProxyAgent> {
	const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7");
	const model: Model<"bedrock-converse-stream"> = { ...baseModel, baseUrl: requestUrl };
	const config = await captureClientConfig(model);
	const requestHandler = config.requestHandler as unknown as InspectableNodeHttpHandler;
	const handlerConfig = await requestHandler.configProvider;
	const agent = await handlerConfig?.httpAgentProvider?.();

	expect(requestHandler.metadata?.handlerProtocol).toBe("http/1.1");
	expect(agent).toBeInstanceOf(ProxyAgent);
	expect(handlerConfig?.httpsAgent).toBe(agent);
	return agent as ProxyAgent;
}

describe("bedrock proxy resolution", () => {
	it("moves response bytes through the configured HTTP proxy", async () => {
		const proxyRequests: string[] = [];
		const targetServer = createTargetServer();
		const proxyServer = createHttpProxyServer(proxyRequests);
		const targetPort = await listenOnLoopback(targetServer);
		const proxyPort = await listenOnLoopback(proxyServer);
		const targetUrl = `http://127.0.0.1:${targetPort}/bedrock-runtime`;
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
		const agent = await captureBedrockProxyAgent(targetUrl);

		try {
			await expect(requestText(targetUrl, agent)).resolves.toEqual({
				body: "bedrock-loopback-ok",
				statusCode: 200,
			});
			expect(proxyRequests).toEqual([targetUrl]);
		} finally {
			agent.destroy();
			await Promise.all([closeServer(proxyServer), closeServer(targetServer)]);
		}
	});

	it.each([
		{ addressType: "ipv4" as const, proxyProtocol: "socks5", targetHost: "127.0.0.1" },
		{ addressType: "domain" as const, proxyProtocol: "socks5h", targetHost: "localhost" },
	])(
		"moves response bytes through the configured $proxyProtocol proxy",
		async ({ addressType, proxyProtocol, targetHost }) => {
			const observations: SocksConnectObservation[] = [];
			const targetServer = createTargetServer();
			const proxyServer = createSocks5ProxyServer(observations);
			const targetPort = await listenOnLoopback(targetServer);
			const proxyPort = await listenOnLoopback(proxyServer);
			const targetUrl = `http://${targetHost}:${targetPort}/bedrock-runtime`;
			process.env.HTTP_PROXY = `${proxyProtocol}://127.0.0.1:${proxyPort}`;
			const agent = await captureBedrockProxyAgent(targetUrl);

			try {
				await expect(requestText(targetUrl, agent)).resolves.toEqual({
					body: "bedrock-loopback-ok",
					statusCode: 200,
				});
				expect(observations).toEqual([{ addressType, host: targetHost, port: targetPort }]);
			} finally {
				agent.destroy();
				await Promise.all([closeServer(proxyServer), closeServer(targetServer)]);
			}
		},
	);
});
