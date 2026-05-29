import { describe, expect, it } from "vitest";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { resolveActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { formatSessionDisplayId, matchesSessionIdSuffix } from "../src/modes/daemon/daemon-session-id.js";

describe("formatSessionDisplayId", () => {
	it("compacts uuid-like session ids to the last 12 hex characters", () => {
		expect(formatSessionDisplayId("019e71ec-e08a-75a9-b573-fc10e9f8380f")).toBe("fc10e9f8380f");
	});

	it("leaves shorter active session ids unchanged", () => {
		expect(formatSessionDisplayId("1bce5c72")).toBe("1bce5c72");
	});
});

describe("matchesSessionIdSuffix", () => {
	it("matches suffixes with or without hyphens", () => {
		const sessionId = "019e71ec-e08a-75a9-b573-fc10e9f8380f";

		expect(matchesSessionIdSuffix(sessionId, "fc10e9f8380f")).toBe(true);
		expect(matchesSessionIdSuffix(sessionId, "e9-f8380f")).toBe(true);
	});
});

describe("resolveActiveSessionState", () => {
	it("resolves unique active session id and session id suffixes", () => {
		const first = makeState("aaaabbbbcccc", "019e71ec-e08a-75a9-b573-fc10e9f8380f");
		const second = makeState("dddd11112222", "029e71ec-e08a-75a9-b573-abcdef123456");
		const sessions = makeSessionMap([first, second]);

		expect(resolveActiveSessionState(sessions, "bbbbcccc")).toBe(first);
		expect(resolveActiveSessionState(sessions, "fc10e9f8380f")).toBe(first);
	});

	it("raises when a suffix matches multiple active sessions", () => {
		const sessions = makeSessionMap([
			makeState("1bce5c72", "019e71ec-e08a-75a9-b573-fc10e9f8380f"),
			makeState("3f9caff0", "029e71ec-f08a-75a9-b573-fc10e9f8380f"),
		]);

		expect(() => resolveActiveSessionState(sessions, "e9f8380f")).toThrow(/Ambiguous active session "e9f8380f"/);
	});
});

function makeSessionMap(states: ActiveSessionState[]): Map<string, ActiveSessionState> {
	return new Map(states.map((state) => [state.activeSessionId, state]));
}

function makeState(activeSessionId: string, sessionId: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		runtime: {
			session: {
				sessionId,
				sessionName: undefined,
			},
		},
	} as unknown as ActiveSessionState;
}
