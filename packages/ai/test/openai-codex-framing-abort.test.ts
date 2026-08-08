import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

type MockWebSocketEventType = "open" | "message" | "error" | "close";
type MockWebSocketListener = (event: unknown) => void;

interface MockWebSocketBehavior {
	onConstruct?: (socket: MockWebSocket) => void;
	onSend?: (socket: MockWebSocket, data: string) => void;
}

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;
let mockWebSocketBehavior: MockWebSocketBehavior = {};

class MockWebSocket {
	static instances: MockWebSocket[] = [];

	readyState = 0;
	readonly sent: string[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	private readonly listeners = new Map<MockWebSocketEventType, Set<MockWebSocketListener>>();

	constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
		MockWebSocket.instances.push(this);
		mockWebSocketBehavior.onConstruct?.(this);
	}

	addEventListener(type: MockWebSocketEventType, listener: MockWebSocketListener): void {
		let listeners = this.listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: MockWebSocketEventType, listener: MockWebSocketListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		this.sent.push(data);
		mockWebSocketBehavior.onSend?.(this, data);
	}

	close(code?: number, reason?: string): void {
		this.closes.push({ code, reason });
		this.readyState = 3;
	}

	dispatch(type: MockWebSocketEventType, event: unknown): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			listener(event);
		}
	}

	open(): void {
		this.readyState = 1;
		this.dispatch("open", {});
	}

	listenerCount(type?: MockWebSocketEventType): number {
		if (type) return this.listeners.get(type)?.size ?? 0;
		return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
	}
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	mockWebSocketBehavior = {};
	MockWebSocket.instances = [];
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function testModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function testContext(content = "Say hello"): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content, timestamp: 1 }],
	};
}

function responseEvents(): Record<string, unknown>[] {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Héllo" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Héllo" }],
			},
		},
		completedEvent(),
	];
}

function completedEvent(responseId?: string): Record<string, unknown> {
	return {
		type: "response.completed",
		response: {
			id: responseId,
			status: "completed",
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				total_tokens: 8,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
}

function buildSSEPayload({
	lineEndings,
	multilineData = false,
	terminalBlankLine = true,
}: {
	lineEndings: readonly string[];
	multilineData?: boolean;
	terminalBlankLine?: boolean;
}): string {
	const lines: string[] = [];
	const events = responseEvents();

	for (const [index, event] of events.entries()) {
		lines.push(": keep-alive", "event: response", `id: ${index + 1}`, "retry: 1000");
		const data = JSON.stringify(event);
		if (multilineData && index === events.length - 1) {
			const splitAt = data.indexOf('"response"');
			lines.push(`data: ${data.slice(0, splitAt)}`, `data: ${data.slice(splitAt)}`);
		} else {
			lines.push(`data: ${data}`);
		}
		if (index < events.length - 1 || terminalBlankLine) {
			lines.push("");
		}
	}

	let payload = "";
	for (const [index, line] of lines.entries()) {
		payload += line;
		if (index < lines.length - 1 || terminalBlankLine) {
			payload += lineEndings[index % lineEndings.length];
		}
	}
	return payload;
}

function responseFromChunks(payload: string, chunkSize: number): Response {
	const bytes = new TextEncoder().encode(payload);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += chunkSize) {
					controller.enqueue(bytes.slice(offset, offset + chunkSize));
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function installSSEFetch(responseFactory: () => Response): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => responseFactory());
	global.fetch = fetchMock as typeof fetch;
	return fetchMock;
}

function installMockWebSocket(): void {
	globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
}

function openOnConstruct(): void {
	mockWebSocketBehavior.onConstruct = (socket) => {
		queueMicrotask(() => socket.open());
	};
}

function completeOnSend(responseId?: string): void {
	mockWebSocketBehavior.onSend = (socket) => {
		queueMicrotask(() => socket.dispatch("message", { data: JSON.stringify(completedEvent(responseId)) }));
	};
}

function abortCalls(calls: readonly (readonly unknown[])[]): number {
	return calls.filter(([type]) => type === "abort").length;
}

async function expectAborted(result: ReturnType<typeof streamOpenAICodexResponses>): Promise<void> {
	const message = await result.result();
	expect(message.stopReason).toBe("aborted");
	expect(message.errorMessage).toBe("Request was aborted");
}

describe("openai-codex SSE framing", () => {
	it.each([
		["LF", ["\n"]],
		["CRLF", ["\r\n"]],
		["mixed LF and CRLF", ["\n", "\r\n", "\r\n", "\n"]],
		["CR", ["\r"]],
	] as const)("parses %s framing across every byte boundary", async (_name, lineEndings) => {
		const payload = buildSSEPayload({ lineEndings, multilineData: true });
		installSSEFetch(() => responseFromChunks(payload, 1));

		const result = await streamOpenAICodexResponses(testModel(), testContext(), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((block) => block.type === "text")?.text).toBe("Héllo");
	});

	it.each([
		["LF", ["\n"]],
		["CRLF", ["\r\n"]],
		["mixed", ["\r\n", "\n"]],
	] as const)("dispatches a terminal %s event without a blank line", async (_name, lineEndings) => {
		const payload = buildSSEPayload({ lineEndings, terminalBlankLine: false });
		installSSEFetch(() => responseFromChunks(payload, 2));

		const result = await streamOpenAICodexResponses(testModel(), testContext(), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((block) => block.type === "text")?.text).toBe("Héllo");
	});
});

describe("openai-codex WebSocket cancellation", () => {
	it("does not construct a socket or fall back for a pre-aborted request", async () => {
		installMockWebSocket();
		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		global.fetch = fetchMock as typeof fetch;
		const controller = new AbortController();
		controller.abort(new Error("custom cancellation reason"));
		mockWebSocketBehavior.onConstruct = () => {
			throw new Error("socket construction must not happen");
		};

		await expectAborted(
			streamOpenAICodexResponses(testModel(), testContext(), {
				apiKey: mockToken(),
				transport: "auto",
				signal: controller.signal,
			}),
		);

		expect(MockWebSocket.instances).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cleans connection listeners when aborted before open", async () => {
		installMockWebSocket();
		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		global.fetch = fetchMock as typeof fetch;
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, "addEventListener");
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		const result = streamOpenAICodexResponses(testModel(), testContext(), {
			apiKey: mockToken(),
			transport: "auto",
			signal: controller.signal,
		});
		await vi.waitFor(() => {
			expect(MockWebSocket.instances[0]?.listenerCount()).toBe(3);
		});
		controller.abort();
		await expectAborted(result);

		const socket = MockWebSocket.instances[0];
		expect(socket.listenerCount()).toBe(0);
		expect(socket.closes).toContainEqual({ code: 1000, reason: "aborted" });
		expect(abortCalls(addSpy.mock.calls)).toBe(abortCalls(removeSpy.mock.calls));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not send when aborted immediately after the socket opens", async () => {
		installMockWebSocket();
		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		global.fetch = fetchMock as typeof fetch;
		const controller = new AbortController();
		mockWebSocketBehavior.onConstruct = (socket) => {
			queueMicrotask(() => {
				socket.open();
				controller.abort();
			});
		};

		await expectAborted(
			streamOpenAICodexResponses(testModel(), testContext(), {
				apiKey: mockToken(),
				transport: "auto",
				signal: controller.signal,
			}),
		);

		const socket = MockWebSocket.instances[0];
		expect(socket.sent).toHaveLength(0);
		expect(socket.listenerCount()).toBe(0);
		expect(socket.closes).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("cleans stream listeners and closes the socket when aborted during streaming", async () => {
		installMockWebSocket();
		const fetchMock = vi.fn(async () => new Response("unexpected fetch", { status: 500 }));
		global.fetch = fetchMock as typeof fetch;
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, "addEventListener");
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
		openOnConstruct();
		mockWebSocketBehavior.onSend = () => {
			queueMicrotask(() => controller.abort());
		};

		await expectAborted(
			streamOpenAICodexResponses(testModel(), testContext(), {
				apiKey: mockToken(),
				transport: "websocket",
				signal: controller.signal,
			}),
		);

		const socket = MockWebSocket.instances[0];
		expect(socket.sent).toHaveLength(1);
		expect(socket.listenerCount()).toBe(0);
		expect(socket.closes).toHaveLength(1);
		expect(abortCalls(addSpy.mock.calls)).toBe(abortCalls(removeSpy.mock.calls));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("leaves a cached socket reusable when a later request is already aborted", async () => {
		installMockWebSocket();
		openOnConstruct();
		completeOnSend("resp_1");
		const sessionId = "cached-pre-abort";

		await streamOpenAICodexResponses(testModel(), testContext("first"), {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId,
		}).result();
		const socket = MockWebSocket.instances[0];
		expect(socket.listenerCount()).toBe(0);

		const controller = new AbortController();
		controller.abort();
		await expectAborted(
			streamOpenAICodexResponses(testModel(), testContext("cancelled"), {
				apiKey: mockToken(),
				transport: "websocket-cached",
				sessionId,
				signal: controller.signal,
			}),
		);

		expect(MockWebSocket.instances).toHaveLength(1);
		expect(socket.sent).toHaveLength(1);
		expect(socket.closes).toHaveLength(0);
		expect(socket.listenerCount()).toBe(0);

		completeOnSend("resp_2");
		await streamOpenAICodexResponses(testModel(), testContext("third"), {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId,
		}).result();
		expect(MockWebSocket.instances).toHaveLength(1);
		expect(socket.sent).toHaveLength(2);
		expect(socket.listenerCount()).toBe(0);
	});

	it("evicts a cached socket when its active stream is aborted", async () => {
		installMockWebSocket();
		openOnConstruct();
		completeOnSend("resp_1");
		const sessionId = "cached-active-abort";

		await streamOpenAICodexResponses(testModel(), testContext("first"), {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId,
		}).result();
		const firstSocket = MockWebSocket.instances[0];

		const controller = new AbortController();
		mockWebSocketBehavior.onSend = () => {
			queueMicrotask(() => controller.abort());
		};
		await expectAborted(
			streamOpenAICodexResponses(testModel(), testContext("second"), {
				apiKey: mockToken(),
				transport: "websocket-cached",
				sessionId,
				signal: controller.signal,
			}),
		);
		expect(firstSocket.listenerCount()).toBe(0);
		expect(firstSocket.closes).toHaveLength(1);

		completeOnSend("resp_3");
		await streamOpenAICodexResponses(testModel(), testContext("third"), {
			apiKey: mockToken(),
			transport: "websocket-cached",
			sessionId,
		}).result();
		expect(MockWebSocket.instances).toHaveLength(2);
		expect(MockWebSocket.instances[1].listenerCount()).toBe(0);
	});

	it.each(["error", "close"] as const)("cleans %s connection listeners before falling back to SSE", async (cause) => {
		installMockWebSocket();
		const payload = buildSSEPayload({ lineEndings: ["\r\n"] });
		const fetchMock = installSSEFetch(() => responseFromChunks(payload, 3));
		mockWebSocketBehavior.onConstruct = (socket) => {
			queueMicrotask(() => {
				if (cause === "error") {
					socket.dispatch("error", { message: "upgrade rejected" });
				} else {
					socket.readyState = 3;
					socket.dispatch("close", { code: 1006, reason: "upgrade rejected", wasClean: false });
				}
			});
		};

		const result = await streamOpenAICodexResponses(testModel(), testContext(), {
			apiKey: mockToken(),
			transport: "auto",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((block) => block.type === "text")?.text).toBe("Héllo");
		expect(MockWebSocket.instances[0].listenerCount()).toBe(0);
		if (cause === "error") {
			expect(MockWebSocket.instances[0].closes).toContainEqual({ code: 1000, reason: "connection_error" });
		}
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
