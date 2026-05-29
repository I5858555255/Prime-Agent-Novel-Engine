import { describe, expect, it } from "vitest";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { resolveActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { formatSessionDisplayId, matchesSessionIdPrefix } from "../src/modes/daemon/daemon-session-id.js";

describe("formatSessionDisplayId", () => {
	it("compacts uuid-like session ids to 12 hex characters", () => {
		expect(formatSessionDisplayId("019e71ec-e08a-75a9-b573-fc10e9f8380f")).toBe("019e71ece08a");
	});

	it("leaves shorter active session ids unchanged", () => {
		expect(formatSessionDisplayId("1bce5c72")).toBe("1bce5c72");
	});
});

describe("matchesSessionIdPrefix", () => {
	it("matches prefixes with or without hyphens", () => {
		const sessionId = "019e71ec-e08a-75a9-b573-fc10e9f8380f";

		expect(matchesSessionIdPrefix(sessionId, "019e71ece08a")).toBe(true);
		expect(matchesSessionIdPrefix(sessionId, "019e71ec-e")).toBe(true);
	});
});

describe("resolveActiveSessionState", () => {
	it("resolves unique active session id and session id prefixes", () => {
		const first = makeState("1bce5c72", "019e71ec-e08a-75a9-b573-fc10e9f8380f");
		const second = makeState("3f9caff0", "029e71ec-e08a-75a9-b573-fc10e9f8380f");
		const sessions = makeSessionMap([first, second]);

		expect(resolveActiveSessionState(sessions, "1bce")).toBe(first);
		expect(resolveActiveSessionState(sessions, "019e71ece08a")).toBe(first);
	});

	it("raises when a prefix matches multiple active sessions", () => {
		const sessions = makeSessionMap([
			makeState("1bce5c72", "019e71ec-e08a-75a9-b573-fc10e9f8380f"),
			makeState("3f9caff0", "019e71ec-f08a-75a9-b573-fc10e9f8380f"),
		]);

		expect(() => resolveActiveSessionState(sessions, "019e71ec")).toThrow(/Ambiguous active session "019e71ec"/);
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
