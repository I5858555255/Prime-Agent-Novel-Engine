import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushAgentTraceUpload, installAgentTraceUpload, uploadAgentTraceFile } from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

interface FetchCall {
	url: string;
	init: RequestInit;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string) {
	return {
		role: "user" as const,
		content: text,
		timestamp: Date.now(),
	};
}

function createFetchRecorder(calls: FetchCall[]): typeof fetch {
	return async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(
			JSON.stringify({
				session_id: "uploaded-session",
				trace_id: "uploaded-trace",
				bytes_stored: 123,
				key: "trace/key.jsonl",
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
}

function writeSession(cwd: string, sessionDir: string, id: string, parentSession?: string): SessionManager {
	const sessionManager = SessionManager.create(cwd, sessionDir);
	sessionManager.newSession({ id, parentSession });
	sessionManager.appendMessage(createUserMessage(`user ${id}`));
	sessionManager.appendMessage(createAssistantMessage(`assistant ${id}`));
	return sessionManager;
}

describe("agent trace upload", () => {
	let tempDir: string;
	let originalTraceApiKey: string | undefined;
	let originalPrimeApiKey: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "agent-traces-test-"));
		originalTraceApiKey = process.env.PRIME_AGENT_TRACES_API_KEY;
		originalPrimeApiKey = process.env.PRIME_API_KEY;
		delete process.env.PRIME_AGENT_TRACES_API_KEY;
		delete process.env.PRIME_API_KEY;
	});

	afterEach(() => {
		if (originalTraceApiKey === undefined) {
			delete process.env.PRIME_AGENT_TRACES_API_KEY;
		} else {
			process.env.PRIME_AGENT_TRACES_API_KEY = originalTraceApiKey;
		}
		if (originalPrimeApiKey === undefined) {
			delete process.env.PRIME_API_KEY;
		} else {
			process.env.PRIME_API_KEY = originalPrimeApiKey;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not upload when trace sharing is disabled", async () => {
		const sessionManager = writeSession(tempDir, join(tempDir, "sessions"), "disabled-session");
		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: sessionManager.getSessionFile(),
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: false } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({ status: "disabled" });
		expect(calls).toHaveLength(0);
	});

	it("uploads raw session JSONL with trace headers", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const parent = writeSession(cwd, sessionDir, "parent-session");
		const child = writeSession(cwd, sessionDir, "child-session", parent.getSessionFile());
		const childSessionFile = child.getSessionFile();
		expect(childSessionFile).toBeDefined();

		const calls: FetchCall[] = [];
		const result = await uploadAgentTraceFile({
			sessionFile: childSessionFile,
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
			reloadConfig: false,
		});

		expect(result).toEqual({
			status: "uploaded",
			sessionId: "uploaded-session",
			traceId: "uploaded-trace",
			bytesStored: 123,
			key: "trace/key.jsonl",
		});
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call.url).toBe("https://api.example.test/api/v1/agent-traces/sessions/child-session");
		expect(call.init.method).toBe("PUT");
		expect(call.init.body).toBe(readFileSync(childSessionFile!, "utf8"));

		const headers = new Headers(call.init.headers);
		expect(headers.get("authorization")).toBe("Bearer trace-key");
		expect(headers.get("content-type")).toBe("application/x-ndjson");
		expect(headers.get("x-trace-id")).toBe("parent-session");
		expect(headers.get("x-parent-session")).toBe("parent-session");
		expect(headers.get("x-cwd")).toBe(cwd);
		expect(headers.get("x-agent-version")).toBeTruthy();
		expect(headers.get("content-length")).toBe(String(Buffer.byteLength(call.init.body as string, "utf8")));
	});

	it("schedules upload only after the session file is persisted", async () => {
		const cwd = join(tempDir, "project");
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.newSession({ id: "listener-session" });

		const calls: FetchCall[] = [];
		installAgentTraceUpload(sessionManager, {
			authStorage: AuthStorage.inMemory({
				[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
			}),
			settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
			baseUrl: "https://api.example.test",
			fetchFn: createFetchRecorder(calls),
		});

		sessionManager.appendMessage(createUserMessage("hello"));
		await flushAgentTraceUpload(sessionManager);
		expect(calls).toHaveLength(0);

		sessionManager.appendMessage(createAssistantMessage("hi"));
		await flushAgentTraceUpload(sessionManager);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.example.test/api/v1/agent-traces/sessions/listener-session");
	});
});
