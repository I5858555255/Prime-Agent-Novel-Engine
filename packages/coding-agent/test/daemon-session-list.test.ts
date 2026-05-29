import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { ActiveSessionRecord, DaemonSocketClient } from "../src/modes/daemon/active-session-record.js";
import type { ActiveSessionState } from "../src/modes/daemon/daemon-protocol.js";
import { buildDaemonSessionList, entryForActiveSessionState } from "../src/modes/daemon/daemon-session-list.js";

describe("buildDaemonSessionList", () => {
	it("derives active session statuses", () => {
		const entries = buildDaemonSessionList(
			[
				makeRecord({ activeSessionId: "model", sessionFile: "/tmp/model.jsonl", isStreaming: true }),
				makeRecord({
					activeSessionId: "tool",
					sessionFile: "/tmp/tool.jsonl",
					isStreaming: true,
					pendingToolCalls: ["tool-1"],
				}),
				makeRecord({ activeSessionId: "needs-user", sessionFile: "/tmp/needs-user.jsonl", clients: 1 }),
				makeRecord({ activeSessionId: "done", sessionFile: "/tmp/done.jsonl" }),
			],
			[],
			new Map(),
		);

		expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
			["model", "model"],
			["tool", "tool"],
			["needs-user", "user"],
			["done", "idle"],
		]);
	});

	it("merges active records with saved sessions and marks inactive sessions", () => {
		const activePath = resolve("/tmp/project/active.jsonl");
		const killedPath = resolve("/tmp/project/killed.jsonl");
		const savedSessions = [
			makeSessionInfo({ path: activePath, id: "saved-active", name: "active saved" }),
			makeSessionInfo({ path: killedPath, id: "saved-killed", name: "killed saved" }),
			makeSessionInfo({ path: resolve("/tmp/project/crashed.jsonl"), id: "saved-crashed" }),
		];

		const entries = buildDaemonSessionList(
			[makeRecord({ activeSessionId: "active-1", sessionFile: activePath, sessionId: "saved-active" })],
			savedSessions,
			new Map([[killedPath, "killed"]]),
		);

		expect(entries).toHaveLength(3);
		expect(entries.map((entry) => [entry.id, entry.sessionId, entry.status])).toEqual([
			["active-1", "saved-active", "idle"],
			["saved-killed", "saved-killed", "killed"],
			["saved-crashed", "saved-crashed", "crashed"],
		]);
		expect(entries[0]!.sessionName).toBe("session active-1");
	});

	it("normalizes active session state responses for table formatting", () => {
		const entry = entryForActiveSessionState({
			activeSessionId: "active-1",
			thinkingLevel: "off",
			isStreaming: false,
			isCompacting: false,
			sessionId: "session-1",
			sessionFile: "/tmp/session-1.jsonl",
			sessionName: "one",
			cwd: "/tmp/project",
			attachedClients: 1,
			messageCount: 2,
			pendingMessageCount: 0,
		} satisfies ActiveSessionState);

		expect(entry).toMatchObject({
			id: "active-1",
			status: "user",
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionName: "one",
		});
	});
});

interface RecordOptions {
	activeSessionId: string;
	sessionFile?: string;
	sessionId?: string;
	isStreaming?: boolean;
	pendingToolCalls?: string[];
	clients?: number;
}

function makeRecord(options: RecordOptions): ActiveSessionRecord {
	const clients = new Set<DaemonSocketClient>();
	for (let index = 0; index < (options.clients ?? 0); index++) {
		clients.add({ id: `client-${index}` } as unknown as DaemonSocketClient);
	}

	return {
		activeSessionId: options.activeSessionId,
		clients,
		runtime: {
			session: {
				model: undefined,
				thinkingLevel: "off",
				isStreaming: options.isStreaming ?? false,
				isCompacting: false,
				sessionFile: options.sessionFile,
				sessionId: options.sessionId ?? `session-${options.activeSessionId}`,
				sessionName: `session ${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
				},
				messages: [] as AgentMessage[],
				pendingMessageCount: 0,
				state: {
					streamingMessage: undefined,
					pendingToolCalls: new Set(options.pendingToolCalls ?? []),
				},
			},
		},
	} as unknown as ActiveSessionRecord;
}

function makeSessionInfo(overrides: { path: string; id: string; name?: string }): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: "/tmp/project",
		name: overrides.name,
		created: new Date("2026-05-01T00:00:00.000Z"),
		modified: new Date("2026-05-02T00:00:00.000Z"),
		messageCount: 2,
		firstMessage: "hello",
		allMessagesText: "hello world",
	};
}
