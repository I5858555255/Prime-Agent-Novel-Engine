import type { Socket } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { ActiveSessionState } from "./daemon-protocol.js";

export interface DaemonSocketClient {
	id: string;
	socket: Socket;
	attachedActiveSessionIds: Set<string>;
	detachInput: () => void;
}

export interface ActiveSessionRecord {
	activeSessionId: string;
	runtime: AgentSessionRuntime;
	clients: Set<DaemonSocketClient>;
	unsubscribe?: () => void;
}

export function stateForRecord(record: ActiveSessionRecord): ActiveSessionState {
	const session = record.runtime.session;
	return {
		activeSessionId: record.activeSessionId,
		model: session.model as Model<Api> | undefined,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		cwd: session.sessionManager.getCwd(),
		attachedClients: record.clients.size,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		streamingMessage: session.state.streamingMessage,
	};
}
