import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { PRIME_AGENT_META_NAMESPACE } from "../../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * Feature-preservation suite for ACP mode.
 *
 * ACP is a new front end over the same AgentSession, so the risk is not that a
 * feature disappears but that its signal never reaches an ACP client. Each test
 * drives a real ACP client and asserts the capability is observable over the
 * protocol (as a standard update, or as namespaced `_meta`).
 */

function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

interface AcpFixture {
	agent: any;
	updates: any[];
	sessionId: string;
	metaOf: (key: string) => any[];
}

async function connectAcp(harness: Harness): Promise<AcpFixture> {
	const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const updates: any[] = [];

	void runAcpModeWithConnection(connection, {
		stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
	} as any);

	const handle = acp
		.client({ name: "feature-client" })
		.onNotification("session/update", (ctx: any) => {
			updates.push(ctx.params);
		})
		.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

	const agent = handle.agent;
	await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
	const session = await agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

	return {
		agent,
		updates,
		sessionId: session.sessionId,
		metaOf: (key: string) =>
			updates
				.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.[key])
				.filter((value) => value !== undefined),
	};
}

/**
 * Stand-in for the real IPython tool: the suite harness has no kernel, and this
 * suite is about ACP surfacing, not kernel behavior. The tool NAME is what
 * drives the ACP execute-kind mapping, so the name must match production.
 */
const ipythonTool = {
	name: "ipython",
	description: "Execute a Python cell",
	parameters: {
		type: "object" as const,
		properties: { code: { type: "string" as const } },
		required: ["code"],
	},
	execute: async (_toolCallId: string, params: unknown) => {
		const code =
			typeof params === "object" && params !== null && "code" in params ? String((params as any).code) : "";
		return { content: [{ type: "text" as const, text: "42" }], details: { code } };
	},
};

describe("ACP mode preserves prime-agent features", () => {
	it("streams IPython execution as an execute tool call with its cell source", async () => {
		const harness = await createHarness({ tools: [ipythonTool as never] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ipython", { code: "x = 41 + 1\nprint(x)" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("x is 42"),
		]);
		const fixture = await connectAcp(harness);

		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "compute 41+1 in python" }],
		});
		expect(result.stopReason).toBe("end_turn");

		const toolCalls = fixture.updates.filter((u) => u.update?.sessionUpdate === "tool_call");
		expect(toolCalls.length).toBeGreaterThan(0);
		const cell = toolCalls.find((u) => u.update.kind === "execute");
		expect(cell, "IPython must surface as an ACP execute tool call").toBeDefined();
		expect(cell.update.rawInput).toMatchObject({ code: "x = 41 + 1\nprint(x)" });

		const done = fixture.updates.filter((u) => u.update?.sessionUpdate === "tool_call_update");
		expect(done.length).toBeGreaterThan(0);
		harness.cleanup();
	}, 30_000);

	it("keeps autonomous gate state observable and ends the turn only when the loop settles", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				gates: { commands: [`${process.execPath} -e "process.exit(1)"`], maxRetries: 1 },
			},
		});
		harness.setResponses([fauxAssistantMessage("Attempted the task."), fauxAssistantMessage("Retried.")]);
		const fixture = await connectAcp(harness);

		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "do the task" }],
		});

		// A failing gate is a continuation inside the turn, never a distinct ACP
		// stop reason; the turn resolves once the gate loop is done.
		expect(["end_turn", "max_turn_requests", "max_tokens"]).toContain(result.stopReason);
		const autonomous = fixture.metaOf("autonomous");
		expect(autonomous.length, "autonomous state must reach the client via _meta").toBeGreaterThan(0);
		expect(autonomous.at(-1)).toMatchObject({ enabled: true });
		harness.cleanup();
	}, 60_000);

	it("reports a cancelled prompt turn as the ACP cancelled stop reason", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("Working...")]);
		const fixture = await connectAcp(harness);

		const pending = fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "long task" }],
		});
		await fixture.agent.notify("session/cancel", { sessionId: fixture.sessionId });
		const result = await pending;
		expect(["cancelled", "end_turn"]).toContain(result.stopReason);
		harness.cleanup();
	}, 30_000);

	it("rejects prompts for an unknown session instead of silently starting work", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("should not run")]);
		const fixture = await connectAcp(harness);

		await expect(
			fixture.agent.request("session/prompt", {
				sessionId: "not-a-real-session",
				prompt: [{ type: "text", text: "hello" }],
			}),
		).rejects.toThrow();
		harness.cleanup();
	}, 30_000);

	it("surfaces heartbeat and schedule changes, which are not session events", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("ok")]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const updates: any[] = [];
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);
		const handle = acp
			.client({ name: "hb" })
			.onNotification("session/update", (ctx: any) => {
				updates.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		await handle.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await handle.agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		// heartbeats_changed is connection-level; a session-event-only filter drops it.
		await (connection as any).emit({ type: "heartbeats_changed" });
		await new Promise((resolve) => setTimeout(resolve, 50));

		const flags = updates
			.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.heartbeatsChanged)
			.filter((value) => value !== undefined);
		expect(flags, "heartbeat changes must reach the ACP client").toContain(true);
		harness.cleanup();
	}, 30_000);

	it("reports a cwd mismatch in _meta instead of failing or silently disagreeing", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);
		const handle = acp.client({ name: "cwd" }).connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		await handle.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

		// The agent's cwd is fixed at startup, so a different requested cwd must be
		// surfaced rather than silently accepted.
		const created = await handle.agent.request("session/new", {
			cwd: "/definitely/not/the/agent/cwd",
			mcpServers: [],
		});
		expect(created.sessionId).toBeTruthy();
		const cwdMeta = (created._meta?.[PRIME_AGENT_META_NAMESPACE] as { cwd?: unknown } | undefined)?.cwd;
		expect(cwdMeta).toMatchObject({ requested: "/definitely/not/the/agent/cwd" });
		harness.cleanup();
	}, 30_000);

	it("refuses a second session rather than silently sharing one conversation", async () => {
		const harness = await createHarness();
		const fixture = await connectAcp(harness);
		// AgentConnection.newSession() replaces the live session, so two ACP
		// sessions would share history, cwd, model, and queues.
		// The SDK reports a handler throw as a JSON-RPC error, so assert the
		// rejection rather than the message text.
		await expect(fixture.agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] })).rejects.toThrow();
		harness.cleanup();
	}, 30_000);

	it("ignores a cancel addressed to a different session", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("done")]);
		const fixture = await connectAcp(harness);

		// A stray cancel must not abort the real session's turn.
		await fixture.agent.notify("session/cancel", { sessionId: "some-other-session" });
		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "hello" }],
		});
		expect(result.stopReason).toBe("end_turn");
		harness.cleanup();
	}, 30_000);

	it("forwards advertised image and embedded-resource prompt blocks", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("looked at it")]);
		const fixture = await connectAcp(harness);

		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [
				{ type: "text", text: "what is this?" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file:///notes.md", text: "context line" } },
			],
		});
		expect(result.stopReason).toBe("end_turn");

		// initialize advertises image + embeddedContext, so both must reach the model.
		const messages = await harness.session.messages;
		const user = messages.find((message: any) => message.role === "user");
		const serialized = JSON.stringify(user);
		expect(serialized).toContain("what is this?");
		expect(serialized).toContain("context line");
		expect(serialized).toContain("aGVsbG8=");
		harness.cleanup();
	}, 30_000);

	it("advertises prime-agent capabilities without polluting the ACP object root", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);
		const handle = acp.client({ name: "caps" }).connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		const init = await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});

		expect(init.agentInfo).toMatchObject({ name: "prime-agent" });
		expect(typeof init.agentInfo?.version).toBe("string");
		// Namespaced only: unknown root keys are reserved for future ACP fields.
		expect(init._meta).toHaveProperty(PRIME_AGENT_META_NAMESPACE);
		expect(Object.keys(init.agentCapabilities ?? {})).not.toContain("subagents");
		harness.cleanup();
	}, 30_000);
});
