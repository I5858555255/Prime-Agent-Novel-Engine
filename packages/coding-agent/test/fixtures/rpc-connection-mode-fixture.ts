import type { AgentConnection, AgentConnectionEventListener } from "../../src/modes/agent-connection/types.js";
import { runRpcModeWithConnection } from "../../src/modes/rpc/rpc-mode.js";

let listener: AgentConnectionEventListener = () => {};

const heartbeat = {
	id: "heartbeat-1",
	status: "active" as const,
	source: "heartbeat" as const,
	activeSessionId: "root-session",
	sessionId: "root",
	sessionFile: "/tmp/root.jsonl",
	cwd: "/tmp",
	prompt: "check status",
	schedule: { kind: "interval" as const, expression: "every 1h", intervalMs: 3_600_000 },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	runCount: 0,
};

const connection = {
	subscribe(next: AgentConnectionEventListener) {
		listener = next;
		return () => {};
	},
	async prompt(_message: string) {
		await listener({ type: "session_event", event: { type: "agent_start" } });
		await new Promise((resolve) => setTimeout(resolve, 10));
	},
	async getAvailableModels() {
		await new Promise((resolve) => setTimeout(resolve, 25));
		return [];
	},
	async listCronJobs() {
		return [heartbeat];
	},
	async listHeartbeats() {
		return [{ job: heartbeat }];
	},
	async getAgentMessageStatus() {
		return {
			paused: false,
			maxMessageChars: 16384,
			maxPendingPerSession: 20,
			rateLimitCapacity: 3,
			rateLimitRefillMs: 1000,
		};
	},
	async sendAgentMessage(targetActiveSessionId: string, message: string) {
		return {
			id: "message-1",
			source: "agent_message" as const,
			target: { activeSessionId: targetActiveSessionId, sessionId: "target" },
			message,
			deliveryStatus: "delivered" as const,
			deliveredAt: "2026-01-01T00:00:00.000Z",
			deliveryMode: "auto" as const,
		};
	},
	async watchSession() {
		return {
			async getMessages() {
				return [{ role: "user" as const, content: "child message", timestamp: 1 }];
			},
			subscribe(next: AgentConnectionEventListener) {
				void next({ type: "session_event", event: { type: "agent_start" } });
				return () => {};
			},
			async getToolDefinition() {
				return undefined;
			},
			async close() {},
		};
	},
	async dispose() {},
} as unknown as AgentConnection;

await runRpcModeWithConnection(connection);
