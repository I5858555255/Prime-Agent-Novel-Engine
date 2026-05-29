import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionInfo } from "../../core/session-manager.js";
import type { ActiveSessionRecord } from "./active-session-record.js";
import type { ActiveSessionState } from "./daemon-protocol.js";

export type DaemonSessionStatus = "user" | "idle" | "tool" | "model" | "killed" | "crashed";

export interface DaemonSessionListEntry {
	id: string;
	status: DaemonSessionStatus;
	activeSessionId?: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	attachedClients: number;
	messageCount: number;
	pendingMessageCount: number;
	streamingMessage?: AgentMessage;
	created?: string;
	modified?: string;
	firstMessage?: string;
	parentSessionPath?: string;
}

export type InactiveDaemonSessionStatus = Extract<DaemonSessionStatus, "crashed" | "killed">;

export function buildDaemonSessionList(
	activeRecords: readonly ActiveSessionRecord[],
	savedSessions: readonly SessionInfo[],
	inactiveStatuses: ReadonlyMap<string, InactiveDaemonSessionStatus>,
): DaemonSessionListEntry[] {
	const activeBySessionFile = new Map<string, ActiveSessionRecord>();

	for (const record of activeRecords) {
		const sessionFile = record.runtime.session.sessionFile;
		if (sessionFile) {
			activeBySessionFile.set(resolve(sessionFile), record);
		}
	}

	const entries: DaemonSessionListEntry[] = [];
	const seenActiveSessionIds = new Set<string>();
	for (const savedSession of savedSessions) {
		const sessionFile = resolve(savedSession.path);
		const activeRecord = activeBySessionFile.get(sessionFile);
		if (activeRecord) {
			entries.push(activeEntryForRecord(activeRecord, savedSession));
			seenActiveSessionIds.add(activeRecord.activeSessionId);
			continue;
		}
		entries.push(inactiveEntryForSession(savedSession, inactiveStatuses.get(sessionFile) ?? "crashed"));
	}

	for (const record of activeRecords) {
		if (!seenActiveSessionIds.has(record.activeSessionId)) {
			entries.push(activeEntryForRecord(record));
		}
	}
	return entries;
}

export function activeEntryForRecord(record: ActiveSessionRecord, savedSession?: SessionInfo): DaemonSessionListEntry {
	const session = record.runtime.session;
	return {
		id: record.activeSessionId,
		status: activeStatusForRecord(record),
		activeSessionId: record.activeSessionId,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.sessionManager.getCwd(),
		model: session.model as Model<Api> | undefined,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		attachedClients: record.clients.size,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		streamingMessage: session.state.streamingMessage,
		created: savedSession?.created.toISOString(),
		modified: savedSession?.modified.toISOString() ?? getSessionFileModifiedIso(session.sessionFile),
		firstMessage: savedSession?.firstMessage,
		parentSessionPath: savedSession?.parentSessionPath,
	};
}

export function inactiveEntryForSession(
	session: SessionInfo,
	status: InactiveDaemonSessionStatus,
): DaemonSessionListEntry {
	return {
		id: session.id,
		status,
		sessionId: session.id,
		sessionFile: session.path,
		sessionName: session.name,
		cwd: session.cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: session.messageCount,
		pendingMessageCount: 0,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		firstMessage: session.firstMessage,
		parentSessionPath: session.parentSessionPath,
	};
}

export function entryForActiveSessionState(state: ActiveSessionState): DaemonSessionListEntry {
	return {
		id: state.activeSessionId,
		status: activeStatusForState(state),
		activeSessionId: state.activeSessionId,
		sessionId: state.sessionId,
		sessionFile: state.sessionFile,
		sessionName: state.sessionName,
		cwd: state.cwd,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		isStreaming: state.isStreaming,
		isCompacting: state.isCompacting,
		attachedClients: state.attachedClients,
		messageCount: state.messageCount,
		pendingMessageCount: state.pendingMessageCount,
		streamingMessage: state.streamingMessage,
	};
}

function activeStatusForRecord(record: ActiveSessionRecord): DaemonSessionStatus {
	const session = record.runtime.session;
	if (session.isStreaming) {
		return session.state.pendingToolCalls.size > 0 ? "tool" : "model";
	}
	return record.clients.size > 0 ? "user" : "idle";
}

function activeStatusForState(state: ActiveSessionState): DaemonSessionStatus {
	if (state.isStreaming) {
		return "model";
	}
	return state.attachedClients > 0 ? "user" : "idle";
}

function getSessionFileModifiedIso(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) {
		return undefined;
	}
	try {
		return statSync(sessionFile).mtime.toISOString();
	} catch {
		return undefined;
	}
}
