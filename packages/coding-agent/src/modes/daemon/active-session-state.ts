import type { Socket } from "node:net";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";

export interface DaemonSocketClient {
	id: string;
	socket: Socket;
	attachedActiveSessionIds: Set<string>;
	detachInput: () => void;
}

export interface ActiveSessionState {
	activeSessionId: string;
	runtime: AgentSessionRuntime;
	clients: Set<DaemonSocketClient>;
	unsubscribe?: () => void;
}
