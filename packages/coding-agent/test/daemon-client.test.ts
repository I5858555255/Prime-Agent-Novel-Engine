import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";

const netMock = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	class MockSocket {
		private readonly listeners = new Map<string, Set<Listener>>();
		readonly writes: string[] = [];
		destroyed = false;

		constructor(readonly path: string) {}

		on(event: string, listener: Listener): this {
			const listeners = this.listeners.get(event) ?? new Set<Listener>();
			listeners.add(listener);
			this.listeners.set(event, listeners);
			return this;
		}

		once(event: string, listener: Listener): this {
			const onceListener: Listener = (...args) => {
				this.off(event, onceListener);
				listener(...args);
			};
			return this.on(event, onceListener);
		}

		off(event: string, listener: Listener): this {
			this.listeners.get(event)?.delete(listener);
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners) {
				return false;
			}
			for (const listener of [...listeners]) {
				listener(...args);
			}
			return true;
		}

		destroy(): this {
			this.destroyed = true;
			return this;
		}

		end(): this {
			return this;
		}

		write(chunk: string | Buffer): boolean {
			this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			return true;
		}

		listenerCount(event: string): number {
			return this.listeners.get(event)?.size ?? 0;
		}
	}

	const sockets: MockSocket[] = [];
	const createConnection = vi.fn((path: string) => {
		const socket = new MockSocket(path);
		sockets.push(socket);
		return socket;
	});

	return { createConnection, sockets };
});

vi.mock("node:net", () => ({
	createConnection: netMock.createConnection,
}));

describe("DaemonClient", () => {
	beforeEach(() => {
		netMock.sockets.length = 0;
		netMock.createConnection.mockClear();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("allows connect retry after the socket emits an error before connecting", async () => {
		const client = new DaemonClient("/tmp/prime-agent-missing.sock");

		const firstAttempt = captureRejection(client.connect());
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;
		expect(firstSocket.listenerCount("data")).toBe(1);

		firstSocket.emit("error", new Error("initial connect failed"));

		await expect(firstAttempt).resolves.toMatchObject({ message: "initial connect failed" });
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect());
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({ message: "retry reached socket" });
	});

	it("allows connect retry after the initial connection times out", async () => {
		vi.useFakeTimers();
		const client = new DaemonClient("/tmp/prime-agent-slow.sock");

		const firstAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(1);
		const firstSocket = netMock.sockets[0]!;

		const timeoutRejection = expect(firstAttempt).resolves.toMatchObject({
			message: "Timed out connecting to daemon socket: /tmp/prime-agent-slow.sock",
		});
		await vi.advanceTimersByTimeAsync(5);
		await timeoutRejection;

		expect(firstSocket.destroyed).toBe(true);
		expect(firstSocket.listenerCount("data")).toBe(0);
		expect(firstSocket.listenerCount("end")).toBe(0);

		const secondAttempt = captureRejection(client.connect(5));
		expect(netMock.sockets).toHaveLength(2);
		netMock.sockets[1]!.emit("error", new Error("retry reached socket"));

		await expect(secondAttempt).resolves.toMatchObject({ message: "retry reached socket" });
	});

	it("serializes activeSessionId for session commands", async () => {
		const client = new DaemonClient("/tmp/prime-agent.sock");

		const connect = client.connect();
		expect(netMock.sockets).toHaveLength(1);
		const socket = netMock.sockets[0]!;
		socket.emit("connect");
		await connect;

		const response = client.request({ type: "attach", activeSessionId: "active-1" });
		expect(socket.writes).toHaveLength(1);
		const command = JSON.parse(socket.writes[0]!.trim()) as {
			id?: string;
			type?: string;
			activeSessionId?: string;
			daemonSessionId?: unknown;
		};

		expect(command).toMatchObject({ type: "attach", activeSessionId: "active-1" });
		expect(command).not.toHaveProperty("daemonSessionId");

		socket.emit(
			"data",
			`${JSON.stringify({ id: command.id, type: "response", command: "attach", success: true })}\n`,
		);
		await expect(response).resolves.toMatchObject({ id: command.id, success: true });

		client.close();
	});
});

async function captureRejection(promise: Promise<void>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw new Error("Expected daemon client to reject with an Error");
	}
	throw new Error("Expected daemon client connect attempt to reject");
}
