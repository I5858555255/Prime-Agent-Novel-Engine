import { createServer } from "node:net";
import type { Message, Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPromptBridge } from "../extensions/prime-a2a/src/agent-bridge.js";
import { buildAgentCard } from "../extensions/prime-a2a/src/card.js";
import { extractResponseText, registerA2ASendTool } from "../extensions/prime-a2a/src/client.js";
import { type A2AConfig, isEndpointAllowed } from "../extensions/prime-a2a/src/config.js";
import { type A2AServerHandle, createA2AServer, type RunPrompt } from "../extensions/prime-a2a/src/server.js";
import type { ExtensionAPI, ExtensionHandler } from "../src/core/extensions/index.js";

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = address && typeof address === "object" ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function makeConfig(overrides: Partial<A2AConfig> = {}): A2AConfig {
	return {
		peers: {},
		allowedEndpoints: [],
		requestTimeoutMs: 5_000,
		server: { enabled: false, host: "127.0.0.1", port: 41241 },
		...overrides,
	};
}

const runningServers: A2AServerHandle[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function createBridgeHarness(sendUserMessage: (content: string) => Promise<void>): {
	bridge: ReturnType<typeof createAgentPromptBridge>;
	emit: <TEvent extends { type: string }>(event: TEvent) => Promise<void>;
} {
	const handlers = new Map<string, ExtensionHandler<{ type: string }>[]>();
	const pi = {
		on: (event: string, handler: ExtensionHandler<{ type: string }>) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	const bridge = createAgentPromptBridge(pi);

	return {
		bridge,
		emit: async (event) => {
			for (const handler of handlers.get(event.type) ?? []) {
				await handler(event, {} as never);
			}
		},
	};
}

async function startMockPeer(runPrompt: RunPrompt): Promise<{ baseUrl: string; handle: A2AServerHandle }> {
	const port = await getFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const card = buildAgentCard({ baseUrl, name: "Mock Peer", description: "Test peer", version: "9.9.9" });
	const handle = createA2AServer({ card, host: "127.0.0.1", port, runPrompt });
	await handle.start();
	runningServers.push(handle);
	return { baseUrl, handle };
}

/** Minimal executable view of the registered tool. */
interface ExecutableTool {
	name: string;
	execute(
		toolCallId: string,
		params: { peer?: string; url?: string; message: string; timeoutMs?: number },
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown }>;
}

function captureSendTool(getConfig: () => A2AConfig): ExecutableTool {
	let captured: unknown;
	const fakePi = {
		registerTool: (tool: unknown) => {
			captured = tool;
		},
	} as unknown as ExtensionAPI;
	registerA2ASendTool(fakePi, getConfig);
	return captured as ExecutableTool;
}

afterEach(async () => {
	await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

describe("buildAgentCard", () => {
	it("produces a JSONRPC card and strips trailing slashes from the url", () => {
		const card = buildAgentCard({
			baseUrl: "http://localhost:41241/",
			name: "Prime Agent",
			description: "desc",
			version: "1.2.3",
		});
		expect(card.url).toBe("http://localhost:41241");
		expect(card.preferredTransport).toBe("JSONRPC");
		expect(card.version).toBe("1.2.3");
		expect(card.capabilities.streaming).toBe(false);
		expect(card.skills.length).toBeGreaterThan(0);
	});
});

describe("isEndpointAllowed", () => {
	it("allows exact and wildcard endpoints and peer urls, denies everything else", () => {
		const config = makeConfig({
			allowedEndpoints: ["https://api.example.com", "https://*.trusted.dev"],
			peers: { reviewer: { url: "http://127.0.0.1:7000" } },
		});

		expect(isEndpointAllowed("https://api.example.com/rpc", config)).toBe(true);
		expect(isEndpointAllowed("https://agent.trusted.dev", config)).toBe(true);
		expect(isEndpointAllowed("http://127.0.0.1:7000/x", config)).toBe(true);

		expect(isEndpointAllowed("https://evil.com", config)).toBe(false);
		// protocol mismatch
		expect(isEndpointAllowed("http://api.example.com", config)).toBe(false);
		// bare apex does not match *.trusted.dev
		expect(isEndpointAllowed("https://trusted.dev", config)).toBe(false);
	});
});

describe("extractResponseText", () => {
	it("reads text from a direct message", () => {
		const message: Message = {
			kind: "message",
			messageId: "m1",
			role: "agent",
			parts: [{ kind: "text", text: "hello" }],
		};
		expect(extractResponseText(message)).toBe("hello");
	});

	it("reads artifact text from a completed task", () => {
		const task: Task = {
			kind: "task",
			id: "t1",
			contextId: "c1",
			status: { state: "completed" },
			artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: "from artifact" }] }],
		};
		expect(extractResponseText(task)).toContain("from artifact");
	});
});

describe("createAgentPromptBridge", () => {
	it("ignores unrelated agent_end events and waits for the submitted prompt to settle", async () => {
		const sentPrompt = deferred<void>();
		const { bridge, emit } = createBridgeHarness(async () => sentPrompt.promise);
		const result = bridge.runPrompt("a2a prompt");
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await Promise.resolve();

		await emit({ type: "before_agent_start", prompt: "local prompt" });
		await emit({ type: "agent_start" });
		await emit({ type: "agent_end", messages: [assistantMessage("wrong reply")] });
		await Promise.resolve();
		expect(settled).toBe(false);

		await emit({ type: "before_agent_start", prompt: "a2a prompt" });
		await emit({ type: "agent_start" });
		await emit({ type: "agent_end", messages: [assistantMessage("retryable error snapshot")] });
		await Promise.resolve();
		expect(settled).toBe(false);

		await emit({ type: "agent_start" });
		await emit({ type: "agent_end", messages: [assistantMessage("final reply")] });
		sentPrompt.resolve();

		await expect(result).resolves.toBe("final reply");
	});

	it("releases the A2A mutex when sendUserMessage rejects before agent_start", async () => {
		const failedPrompt = deferred<void>();
		const successfulPrompt = deferred<void>();
		let calls = 0;
		const { bridge, emit } = createBridgeHarness(async () => {
			calls++;
			return calls === 1 ? failedPrompt.promise : successfulPrompt.promise;
		});

		const first = bridge.runPrompt("fail");
		await Promise.resolve();
		failedPrompt.reject(new Error("missing model"));
		await expect(first).rejects.toThrow("missing model");

		const second = bridge.runPrompt("ok");
		await Promise.resolve();
		await Promise.resolve();
		expect(calls).toBe(2);

		await emit({ type: "before_agent_start", prompt: "ok" });
		await emit({ type: "agent_start" });
		await emit({ type: "agent_end", messages: [assistantMessage("ok reply")] });
		successfulPrompt.resolve();

		await expect(second).resolves.toBe("ok reply");
	});
});

describe("A2A server round-trip", () => {
	it("serves an agent card and answers message/send via runPrompt", async () => {
		const { baseUrl } = await startMockPeer(async (text) => `echo: ${text}`);

		const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`);
		expect(cardResponse.status).toBe(200);
		const card = (await cardResponse.json()) as { name: string; url: string };
		expect(card.name).toBe("Mock Peer");
		expect(card.url).toBe(baseUrl);

		const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
		const client = await factory.createFromUrl(baseUrl);
		const result = await client.sendMessage({
			message: {
				kind: "message",
				messageId: "req-1",
				role: "user",
				parts: [{ kind: "text", text: "hello" }],
			},
			configuration: { blocking: true, acceptedOutputModes: ["text/plain"] },
		});

		expect(extractResponseText(result)).toContain("echo: hello");
	});
});

describe("a2a_send tool", () => {
	it("calls a configured peer and wraps the reply as untrusted data", async () => {
		const { baseUrl } = await startMockPeer(async (text) => `reply to: ${text}`);
		const tool = captureSendTool(() => makeConfig({ peers: { mock: { url: baseUrl } } }));

		const result = await tool.execute("call-1", { peer: "mock", message: "ping" });
		const text = result.content.map((part) => part.text).join("\n");

		expect(result.isError).toBeFalsy();
		expect(text).toContain("reply to: ping");
		expect(text.toLowerCase()).toContain("untrusted");
	});

	it("denies an unknown peer", async () => {
		const tool = captureSendTool(() => makeConfig());
		const result = await tool.execute("call-2", { peer: "ghost", message: "hi" });
		expect(result.isError).toBe(true);
		expect(result.content.map((part) => part.text).join("\n")).toContain("Unknown peer");
	});

	it("denies a url that is not allowlisted", async () => {
		const tool = captureSendTool(() => makeConfig());
		const result = await tool.execute("call-3", { url: "https://not-allowed.example.com", message: "hi" });
		expect(result.isError).toBe(true);
		expect(result.content.map((part) => part.text).join("\n")).toContain("not allowed");
	});
});
