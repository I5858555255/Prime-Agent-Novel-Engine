import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessageEvent, type Context, getApiProvider, resetApiProviders } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	CURSOR_CLI_API,
	CURSOR_CLI_AUTH_TOKEN,
	CURSOR_CLI_PROVIDER_ID,
	getCursorCliCommand,
	getCursorCliModels,
	isCursorCliAvailable,
	registerCursorCliProvider,
	streamCursorCli,
} from "../src/core/cursor-cli-provider.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { isApiKeyLoginProvider } from "../src/modes/interactive/auth-flows.js";

const FAKE_CURSOR_AGENT = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const logPath = process.env.CURSOR_TEST_LOG;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\\n");
log({ startup: true, cwd: process.cwd(), env: {
  cursorApiKey: process.env.CURSOR_API_KEY,
  primeApiKey: process.env.PRIME_API_KEY,
} });
let buffer = "";
let configOptions = [
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "agent", options: [
    { value: "agent", name: "Agent" },
    ...(process.env.CURSOR_TEST_NO_ASK ? [] : [{ value: "ask", name: "Ask" }]),
  ] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "composer-2.5", options: [
    { value: "composer-2.5", name: "Composer 2.5" },
    { value: "grok-4.5", name: "Cursor Grok 4.5" },
  ] },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [
    { value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" },
  ] },
  { id: "fast", name: "Fast", category: "model_config", type: "select", currentValue: "true", options: [
    { value: "false", name: "Off" }, { value: "true", name: "Fast" },
  ] },
];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    log({ method: request.method, params: request.params });
    if (request.method === "initialize") {
      respond(request.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    } else if (request.method === "session/new") {
      respond(request.id, { sessionId: "fake-session", configOptions });
    } else if (request.method === "session/set_config_option") {
      configOptions = configOptions.map((option) => option.id === request.params.configId
        ? { ...option, currentValue: request.params.value }
        : option);
      respond(request.id, { configOptions });
    } else if (request.method === "session/prompt" && !process.env.CURSOR_TEST_HANG_PROMPT) {
      const text = process.env.CURSOR_TEST_RESPONSE || JSON.stringify({ content: [
        { type: "text", text: "ready" },
        { type: "toolCall", name: "ipython", arguments: { code: "1 + 1" } },
      ] });
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: "fake-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      } });
      respond(request.id, { stopReason: "end_turn", usage: {
        inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 1, totalTokens: 18,
      } });
    }
  }
});
`;

interface FakeLogEntry {
	startup?: boolean;
	cwd?: string;
	env?: { cursorApiKey?: string; primeApiKey?: string };
	method?: string;
	params?: Record<string, unknown>;
}

async function collectStream(
	stream: ReturnType<typeof streamCursorCli>,
): Promise<{ events: AssistantMessageEvent[]; message: Awaited<ReturnType<typeof stream.result>> }> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return { events, message: await stream.result() };
}

describe("Cursor CLI provider", () => {
	let tempDir: string;
	let executablePath: string;
	let logPath: string;
	let originalCursorAgentPath: string | undefined;
	let originalCursorApiKey: string | undefined;
	let originalPrimeApiKey: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-cursor-test-"));
		executablePath = join(tempDir, "cursor-agent");
		logPath = join(tempDir, "cursor.log");
		writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
		chmodSync(executablePath, 0o755);
		originalCursorAgentPath = process.env.CURSOR_AGENT_PATH;
		originalCursorApiKey = process.env.CURSOR_API_KEY;
		originalPrimeApiKey = process.env.PRIME_API_KEY;
		process.env.CURSOR_AGENT_PATH = executablePath;
		process.env.CURSOR_TEST_LOG = logPath;
		process.env.CURSOR_API_KEY = "cursor-secret";
		process.env.PRIME_API_KEY = "prime-secret";
	});

	afterEach(() => {
		for (const key of ["CURSOR_TEST_LOG", "CURSOR_TEST_NO_ASK", "CURSOR_TEST_HANG_PROMPT", "CURSOR_TEST_RESPONSE"]) {
			delete process.env[key];
		}
		if (originalCursorAgentPath === undefined) delete process.env.CURSOR_AGENT_PATH;
		else process.env.CURSOR_AGENT_PATH = originalCursorAgentPath;
		if (originalCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
		else process.env.CURSOR_API_KEY = originalCursorApiKey;
		if (originalPrimeApiKey === undefined) delete process.env.PRIME_API_KEY;
		else process.env.PRIME_API_KEY = originalPrimeApiKey;
		resetApiProviders();
		rmSync(tempDir, { force: true, recursive: true });
	});

	test("detects an explicitly configured executable", () => {
		expect(getCursorCliCommand()).toBe(executablePath);
		expect(isCursorCliAvailable()).toBe(true);
		process.env.CURSOR_AGENT_PATH = join(tempDir, "missing");
		expect(isCursorCliAvailable()).toBe(false);
	});

	test("registers Composer and Grok as locally authenticated models", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const models = getCursorCliModels();
		expect(models.map((model) => model.id)).toEqual(["composer-2.5", "grok-4.5"]);
		expect(models.every((model) => model.provider === CURSOR_CLI_PROVIDER_ID && model.api === CURSOR_CLI_API)).toBe(
			true,
		);
		expect(registry.getAvailable().filter((model) => model.provider === CURSOR_CLI_PROVIDER_ID)).toHaveLength(2);
		expect(registry.getProviderAuthStatus(CURSOR_CLI_PROVIDER_ID).configured).toBe(true);
		await expect(registry.getApiKeyForProvider(CURSOR_CLI_PROVIDER_ID)).resolves.toBe(CURSOR_CLI_AUTH_TOKEN);
		expect(getApiProvider(CURSOR_CLI_API)?.api).toBe(CURSOR_CLI_API);
	});

	test("does not offer Cursor as an API-key login", () => {
		expect(isApiKeyLoginProvider(CURSOR_CLI_PROVIDER_ID, new Set(), new Set())).toBe(false);
	});

	test("re-registers the API provider after a registry reset", () => {
		registerCursorCliProvider();
		expect(getApiProvider(CURSOR_CLI_API)?.api).toBe(CURSOR_CLI_API);
		resetApiProviders();
		expect(getApiProvider(CURSOR_CLI_API)).toBeUndefined();
		registerCursorCliProvider();
		expect(getApiProvider(CURSOR_CLI_API)?.api).toBe(CURSOR_CLI_API);
	});

	test("negotiates Grok options and converts structured output to Prime events", async () => {
		writeFileSync(executablePath, FAKE_CURSOR_AGENT);
		chmodSync(executablePath, 0o755);
		const model = getCursorCliModels().find((candidate) => candidate.id === "grok-4.5");
		expect(model).toBeDefined();
		const context: Context = {
			systemPrompt: "Use Prime tools.",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "encrypted", thinkingSignature: "opaque", redacted: true },
						{ type: "text", text: "prior answer", textSignature: "opaque-text" },
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "orphan",
							name: "ipython",
							arguments: { code: "old" },
							thoughtSignature: "private",
						},
					],
					api: "google-generative-ai",
					provider: "google",
					model: "gemini",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "continue", timestamp: 3 },
				{
					role: "assistant",
					content: [{ type: "text", text: "partial" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "aborted",
					timestamp: 4,
				},
			],
			tools: [{ name: "ipython", description: "Run Python", parameters: Type.Object({ code: Type.String() }) }],
		};
		const { events, message } = await collectStream(streamCursorCli(model!, context, { reasoning: "medium" }));
		expect(message.stopReason).toBe("toolUse");
		expect(message.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);

		const log = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as FakeLogEntry);
		expect(log[0]?.env).toEqual({ cursorApiKey: "cursor-secret" });
		const configWrites = log.filter((entry) => entry.method === "session/set_config_option");
		expect(configWrites.map((entry) => entry.params)).toMatchObject([
			{ configId: "model", value: "grok-4.5" },
			{ configId: "effort", value: "medium" },
			{ configId: "fast", value: "false" },
			{ configId: "mode", value: "ask" },
		]);
		const promptEntry = log.find((entry) => entry.method === "session/prompt");
		const prompt =
			(promptEntry?.params?.prompt as Array<{ type: string; text?: string }> | undefined)?.[0]?.text ?? "";
		expect(prompt).not.toContain("opaque");
		expect(prompt).not.toContain("textSignature");
		expect(prompt).not.toContain("thoughtSignature");
		expect(prompt).not.toContain("partial");
		expect(prompt).toContain("No result provided");
		expect(log[0]?.cwd).toMatch(/prime-agent-cursor-/);
		expect(existsSync(log[0]?.cwd ?? "")).toBe(false);
	});

	test("fails closed when Ask mode is unavailable", async () => {
		writeFileSync(executablePath, FAKE_CURSOR_AGENT);
		chmodSync(executablePath, 0o755);
		process.env.CURSOR_TEST_NO_ASK = "1";
		const model = getCursorCliModels()[0];
		const { message } = await collectStream(streamCursorCli(model!, { messages: [] }));
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Ask mode");
		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain("session/prompt");
	});

	test("terminates malformed, missing, and timed-out CLI requests as stream errors", async () => {
		writeFileSync(executablePath, FAKE_CURSOR_AGENT);
		chmodSync(executablePath, 0o755);
		const model = getCursorCliModels()[0];
		process.env.CURSOR_TEST_RESPONSE = "not json";
		const malformed = await collectStream(streamCursorCli(model!, { messages: [] }));
		expect(malformed.message.stopReason).toBe("error");
		expect(malformed.message.errorMessage).toContain("JSON object");

		process.env.CURSOR_AGENT_PATH = join(tempDir, "missing");
		const missing = await collectStream(streamCursorCli(model!, { messages: [] }, { timeoutMs: 500 }));
		expect(missing.message.stopReason).toBe("error");

		process.env.CURSOR_AGENT_PATH = executablePath;
		const invalidTimeout = await collectStream(streamCursorCli(model!, { messages: [] }, { timeoutMs: -1 }));
		expect(invalidTimeout.message.stopReason).toBe("error");

		const controller = new AbortController();
		controller.abort();
		const aborted = await collectStream(streamCursorCli(model!, { messages: [] }, { signal: controller.signal }));
		expect(aborted.message.stopReason).toBe("aborted");

		delete process.env.CURSOR_TEST_RESPONSE;
		process.env.CURSOR_TEST_HANG_PROMPT = "1";
		const timedOut = await collectStream(streamCursorCli(model!, { messages: [] }, { timeoutMs: 100 }));
		expect(timedOut.message.stopReason).toBe("error");
		expect(timedOut.message.errorMessage).toContain("timed out");
	});
});
