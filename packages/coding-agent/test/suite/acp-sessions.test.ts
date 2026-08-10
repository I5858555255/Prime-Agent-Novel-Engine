import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AgentConnection } from "../../src/modes/agent-connection/types.js";
import { runAcpModeWithConnection } from "../../src/modes/acp/acp-mode.js";

async function connect(connection: AgentConnection) {
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const updates: any[] = [];

	void runAcpModeWithConnection(connection, {
		stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		ownStdout: false,
	});

	const handle = acp
		.client({ name: "session-test-client" })
		.onNotification("session/update", (ctx: any) => updates.push(ctx.params))
		.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

	await handle.agent.request("initialize", {
		protocolVersion: acp.PROTOCOL_VERSION,
		clientCapabilities: {},
	});
	return { agent: handle.agent, updates };
}

function fakeConnection(overrides: Partial<AgentConnection> = {}): AgentConnection {
	return {
		listSavedSessions: vi.fn(async () => []),
		switchSession: vi.fn(async () => ({ cancelled: false })),
		getMessages: vi.fn(async () => []),
		subscribe: vi.fn(() => () => {}),
		dispose: vi.fn(async () => {}),
		...overrides,
	} as unknown as AgentConnection;
}

describe("ACP persisted sessions", () => {
	it("lists saved sessions with ACP metadata and cwd filtering", async () => {
		const connection = fakeConnection({
			listSavedSessions: vi.fn(async () => [
				{
					path: "/sessions/one.jsonl",
					id: "session-one",
					cwd: "/workspace/one",
					name: "First session",
					created: new Date("2026-08-01T10:00:00Z"),
					modified: new Date("2026-08-02T12:00:00Z"),
					messageCount: 2,
					firstMessage: "hello",
					allMessagesText: "hello world",
				},
				{
					path: "/sessions/two.jsonl",
					id: "session-two",
					cwd: "/workspace/two",
					created: new Date("2026-08-03T10:00:00Z"),
					modified: new Date("2026-08-04T12:00:00Z"),
					messageCount: 1,
					firstMessage: "second",
					allMessagesText: "second",
				},
			] as any),
		});
		const { agent } = await connect(connection);

		const result = await agent.request("session/list", { cwd: "/workspace/one" });
		expect(result.sessions).toEqual([
			{
				sessionId: "session-one",
				cwd: "/workspace/one",
				title: "First session",
				updatedAt: "2026-08-02T12:00:00.000Z",
			},
		]);
	});

	it("loads a saved session and replays its text history", async () => {
		const switchSession = vi.fn(async () => ({ cancelled: false }));
		const connection = fakeConnection({
			listSavedSessions: vi.fn(async () => [
				{
					path: "/sessions/loaded.jsonl",
					id: "loaded-session",
					cwd: "/workspace/project",
					created: new Date("2026-08-01T10:00:00Z"),
					modified: new Date("2026-08-02T12:00:00Z"),
					messageCount: 2,
					firstMessage: "hello",
					allMessagesText: "hello hi",
				},
			] as any),
			switchSession,
			getMessages: vi.fn(async () => [
				{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
			] as any),
		});
		const { agent, updates } = await connect(connection);

		const result = await agent.request("session/load", {
			sessionId: "loaded-session",
			cwd: "/workspace/project",
			mcpServers: [],
		});

		expect(result.sessionId).toBe("loaded-session");
		expect(switchSession).toHaveBeenCalledWith("/sessions/loaded.jsonl", { cwdOverride: "/workspace/project" });
		expect(updates.map((item) => item.update)).toEqual([
			{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } },
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
		]);
	});
});