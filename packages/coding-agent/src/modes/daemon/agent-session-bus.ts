export type AgentSessionMessageDeliveryMode = "auto" | "steer" | "follow_up";

export interface AgentSessionMessageEndpoint {
	activeSessionId: string;
	sessionId: string;
	sessionName?: string;
}

export interface AgentSessionMessageSender extends Partial<AgentSessionMessageEndpoint> {
	clientId?: string;
}

export interface AgentSessionMessagePayload {
	message: string;
	from?: AgentSessionMessageSender;
	target: AgentSessionMessageEndpoint;
	deliveryMode: AgentSessionMessageDeliveryMode;
}

export interface AgentSessionMessageReceipt {
	target: AgentSessionMessageEndpoint;
	from?: AgentSessionMessageSender;
	message: string;
	deliveredAt: string;
	deliveryMode: AgentSessionMessageDeliveryMode;
}

export function normalizeAgentSessionMessage(message: string): string {
	const trimmed = message.trim();
	if (!trimmed) {
		throw new Error("Agent session message cannot be empty");
	}
	return trimmed;
}

export function resolveAgentSessionMessageStreamingBehavior(
	isTargetStreaming: boolean,
	deliveryMode: AgentSessionMessageDeliveryMode | undefined,
): "steer" | "followUp" | undefined {
	const mode = deliveryMode ?? "auto";
	if (!isTargetStreaming) {
		return undefined;
	}
	if (mode === "steer") {
		return "steer";
	}
	return "followUp";
}

export function createAgentSessionMessagePrompt(payload: AgentSessionMessagePayload): string {
	const lines = ["Agent-to-agent message received."];
	if (payload.from) {
		lines.push(`From: ${formatAgentSessionMessageSender(payload.from)}`);
	}
	lines.push(`To: ${formatAgentSessionMessageEndpoint(payload.target)}`);
	lines.push("");
	lines.push(payload.message);
	return lines.join("\n");
}

export function createAgentSessionMessageReceipt(
	payload: AgentSessionMessagePayload,
	deliveredAt = new Date().toISOString(),
): AgentSessionMessageReceipt {
	return {
		target: payload.target,
		from: payload.from,
		message: payload.message,
		deliveredAt,
		deliveryMode: payload.deliveryMode,
	};
}

function formatAgentSessionMessageSender(sender: AgentSessionMessageSender): string {
	const parts: string[] = [];
	if (sender.sessionName) {
		parts.push(sender.sessionName);
	}
	if (sender.activeSessionId) {
		parts.push(`active ${sender.activeSessionId}`);
	}
	if (sender.sessionId) {
		parts.push(`session ${sender.sessionId}`);
	}
	if (sender.clientId && parts.length > 0) {
		parts.push(`client ${sender.clientId}`);
	}
	if (sender.clientId && parts.length === 0) {
		parts.push(`client ${sender.clientId}`);
	}
	return parts.length > 0 ? parts.join(", ") : "unknown sender";
}

function formatAgentSessionMessageEndpoint(endpoint: AgentSessionMessageEndpoint): string {
	const name = endpoint.sessionName ? `${endpoint.sessionName}, ` : "";
	return `${name}active ${endpoint.activeSessionId}, session ${endpoint.sessionId}`;
}
