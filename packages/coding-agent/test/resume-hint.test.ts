import { describe, expect, test } from "vitest";
import { APP_NAME } from "../src/config.js";
import { formatResumeHint } from "../src/modes/interactive/resume-hint.js";

const SESSION_ID = "0196c2e4-7f01-7abc-8def-0123456789ab";

describe("formatResumeHint", () => {
	test("returns hint with --session and the session id for a persisted session", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: `/home/user/.prime/agent/sessions/${SESSION_ID}.jsonl`,
			userMessages: 3,
		});
		expect(hint).toBeDefined();
		expect(hint).toContain(`${APP_NAME} --session ${SESSION_ID}`);
	});

	test("returns undefined for an in-memory session", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: undefined,
			userMessages: 3,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when the session has no user messages", () => {
		const hint = formatResumeHint({
			sessionId: SESSION_ID,
			sessionFile: `/home/user/.prime/agent/sessions/${SESSION_ID}.jsonl`,
			userMessages: 0,
		});
		expect(hint).toBeUndefined();
	});

	test("returns undefined when stats are unavailable", () => {
		expect(formatResumeHint(undefined)).toBeUndefined();
	});
});
