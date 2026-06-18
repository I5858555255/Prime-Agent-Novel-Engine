import { describe, expect, test, vi } from "vitest";
import {
	DeferredAgentConnection,
	type DeferredAgentConnectionSeed,
} from "../src/modes/agent-connection/deferred-agent-connection.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionModel,
} from "../src/modes/agent-connection/types.js";

const MODEL = { provider: "anthropic", id: "claude-x" } as unknown as AgentConnectionModel;

const SEED: DeferredAgentConnectionSeed = {
	cwd: "/tmp/project",
	sessionDir: "/tmp/sessions",
	model: MODEL,
	thinkingLevel: "off",
	scopedModels: [],
	availableModels: [MODEL],
	steeringMode: "all",
	followUpMode: "all",
	autoCompactionEnabled: true,
};

class FakeRealConnection {
	readonly listeners = new Set<(event: AgentConnectionEvent) => void>();
	readonly beforeInvalidate = new Set<() => void>();
	readonly promptCalls: string[] = [];
	disposed = false;

	subscribe(listener: (event: AgentConnectionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onBeforeSessionInvalidate(listener: () => void): () => void {
		this.beforeInvalidate.add(listener);
		return () => this.beforeInvalidate.delete(listener);
	}
	emit(event: AgentConnectionEvent): void {
		for (const listener of [...this.listeners]) {
			listener(event);
		}
	}
	async getState() {
		return { sessionId: "real-session", cwd: "/tmp/project" };
	}
	async getMessages() {
		return [{ role: "user", content: "hi" }];
	}
	async prompt(message: string) {
		this.promptCalls.push(message);
	}
	async dispose() {
		this.disposed = true;
	}
}

function makeFactory(fake = new FakeRealConnection()) {
	const factory = vi.fn(async () => fake as unknown as AgentConnection);
	return { factory, fake };
}

describe("DeferredAgentConnection", () => {
	test("serves local catalog and creates nothing for reads or dispose", async () => {
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		const state = await conn.getState();
		expect(state.model).toBe(MODEL);
		expect(state.cwd).toBe("/tmp/project");
		expect(state.messageCount).toBe(0);
		expect(await conn.getCommands()).toEqual([]);
		expect(await conn.getMessages()).toEqual([]);
		expect(await conn.getAvailableModels()).toEqual([MODEL]);
		expect(await conn.getQueue()).toEqual({ steering: [], followUp: [] });
		expect((await conn.getSessionStats()).totalMessages).toBe(0);

		await conn.dispose();
		expect(factory).not.toHaveBeenCalled();
		expect(conn.created).toBe(false);
	});

	test("creates the session on first prompt and delegates", async () => {
		const { factory, fake } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const events: AgentConnectionEvent[] = [];
		conn.subscribe((event) => {
			events.push(event);
		});

		await conn.prompt("do the thing");

		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.promptCalls).toEqual(["do the thing"]);
		expect(conn.created).toBe(true);
		expect(events.some((event) => event.type === "session_replaced")).toBe(true);
	});

	test("is single-flight when actions race the first creation", async () => {
		const { factory, fake } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		await Promise.all([conn.prompt("a"), conn.prompt("b")]);

		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.promptCalls.sort()).toEqual(["a", "b"]);
	});

	test("pipes real connection events through after promotion", async () => {
		const { fake, factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const events: AgentConnectionEvent[] = [];
		conn.subscribe((event) => {
			events.push(event);
		});

		await conn.prompt("go");
		const replacedCount = events.filter((event) => event.type === "session_replaced").length;
		fake.emit({ type: "session_status", recap: "working" });

		expect(events.at(-1)).toEqual({ type: "session_status", recap: "working" });
		// Promotion emits exactly one session_replaced; later events are not re-replays.
		expect(replacedCount).toBe(1);
	});

	test("buffers onBeforeSessionInvalidate listeners until promotion", async () => {
		const { fake, factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const listener = vi.fn();
		conn.onBeforeSessionInvalidate(listener);

		expect(fake.beforeInvalidate.size).toBe(0);
		await conn.prompt("go");
		expect(fake.beforeInvalidate.has(listener)).toBe(true);
	});

	test("dispose after creation tears down the real connection", async () => {
		const { fake, factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);
		const events: AgentConnectionEvent[] = [];
		conn.subscribe((event) => {
			events.push(event);
		});
		await conn.prompt("go");

		await conn.dispose();
		expect(fake.disposed).toBe(true);

		const countAfterDispose = events.length;
		fake.emit({ type: "session_status", recap: "late" });
		expect(events.length).toBe(countAfterDispose);
	});

	test("read-only stop actions never create a session", async () => {
		const { factory } = makeFactory();
		const conn = new DeferredAgentConnection(factory, SEED);

		await conn.abort();
		await conn.waitForIdle();
		await conn.abortBash();
		expect(await conn.cancelRlmChild("child")).toBe(false);

		expect(factory).not.toHaveBeenCalled();
		expect(conn.created).toBe(false);
	});
});
