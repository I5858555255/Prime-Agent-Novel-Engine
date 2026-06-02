import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonClientMock = vi.hoisted(() => {
	type Listener = (message: { type: string; activeSessionId?: string; event?: { type: string } }) => void;
	type CloseListener = (error: Error) => void;
	type Command = { type: string };
	type Response =
		| { type: "response"; command: string; success: true }
		| { type: "response"; command: string; success: false; error: string };

	const instances: MockDaemonClient[] = [];

	class MockDaemonClient {
		readonly messageListeners = new Set<Listener>();
		readonly closeListeners = new Set<CloseListener>();
		readonly requests: Command[] = [];
		messageListenerCountAtClose: number | undefined;
		closeListenerCountAtClose: number | undefined;

		constructor(readonly socketPath: string) {
			instances.push(this);
		}

		async connect(): Promise<void> {}

		async request(command: Command): Promise<Response> {
			this.requests.push(command);
			if (command.type === "prompt") {
				return { type: "response", command: command.type, success: false, error: "prompt failed" };
			}
			return { type: "response", command: command.type, success: true };
		}

		onMessage(listener: Listener): () => void {
			this.messageListeners.add(listener);
			return () => {
				this.messageListeners.delete(listener);
			};
		}

		onClose(listener: CloseListener): () => void {
			this.closeListeners.add(listener);
			return () => {
				this.closeListeners.delete(listener);
			};
		}

		emitMessage(message: Parameters<Listener>[0]): void {
			for (const listener of [...this.messageListeners]) {
				listener(message);
			}
		}

		close(): void {
			this.messageListenerCountAtClose = this.messageListeners.size;
			this.closeListenerCountAtClose = this.closeListeners.size;
			for (const listener of [...this.closeListeners]) {
				listener(new Error("closed"));
			}
		}
	}

	return { MockDaemonClient, instances };
});

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: daemonClientMock.MockDaemonClient,
}));

import { handleDaemonCommand } from "../src/cli/daemon-command.js";

describe("daemon command", () => {
	let consoleErrorMessages: unknown[];

	beforeEach(() => {
		daemonClientMock.instances.length = 0;
		consoleErrorMessages = [];
		vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null | undefined) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation((...messages: unknown[]) => {
			consoleErrorMessages.push(...messages);
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("cleans prompt listeners when the prompt request fails", async () => {
		await expect(
			handleDaemonCommand(["daemon", "--socket", "/tmp/prime-agent.sock", "prompt", "active-1", "hello"]),
		).rejects.toThrow("exit 1");

		const client = daemonClientMock.instances[0];
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
		expect(
			consoleErrorMessages.some((message) => typeof message === "string" && message.includes("prompt failed")),
		).toBe(true);
	});

	it("ends json attach when the session closes", async () => {
		const command = handleDaemonCommand([
			"daemon",
			"--socket",
			"/tmp/prime-agent.sock",
			"--json",
			"attach",
			"active-1",
		]);

		await flushPromises();

		const client = daemonClientMock.instances[0];
		expect(client?.requests.map((request) => request.type)).toEqual(["attach"]);

		client?.emitMessage({ type: "session_closed", activeSessionId: "active-1" });

		await expect(command).resolves.toBe(true);
		expect(client?.messageListenerCountAtClose).toBe(0);
		expect(client?.closeListenerCountAtClose).toBe(0);
	});
});

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
