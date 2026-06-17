import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { DaemonSessionSummarizer } from "../src/modes/daemon/daemon-session-summarizer.js";

// The debounce the summarizer waits for after a turn settles (kept in sync with
// SETTLE_DEBOUNCE_MS in the module).
const SETTLE_MS = 2000;

function makeState(opts: { working?: boolean; messages?: number } = {}): ActiveSessionState {
	const appended: unknown[] = [];
	return {
		activeSessionId: "a1",
		summaryState: undefined,
		runtime: {
			metadata: { kind: "top-level" },
			session: {
				isStreaming: opts.working ?? false,
				isCompacting: false,
				pendingMessageCount: 0,
				messages: Array.from({ length: opts.messages ?? 2 }, () => ({ role: "user", content: "hi" })),
				modelRegistry: {},
				sessionManager: { appendAgentStatus: (s: unknown) => appended.push(s) },
			},
		},
	} as unknown as ActiveSessionState;
}

describe("DaemonSessionSummarizer lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("runs the model call after the settle debounce and records the verdict", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue({ summary: "Added the health endpoint", taskState: "completed" });
		const onStatusChanged = vi.fn();
		const summarizer = new DaemonSessionSummarizer(() => [], onStatusChanged, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		// No model call until the agent has settled for the debounce window.
		await vi.advanceTimersByTimeAsync(SETTLE_MS - 500);
		expect(generate).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(600);
		expect(generate).toHaveBeenCalledOnce();
		expect(state.summaryState).toMatchObject({ summary: "Added the health endpoint", taskState: "completed" });
		expect(onStatusChanged).toHaveBeenCalled();
	});

	test("a failing model leaves no verdict — the view then defaults to completed", async () => {
		vi.useFakeTimers();
		const generate = vi.fn().mockResolvedValue(undefined); // 404 / 401 / timeout / unparseable
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);
		const state = makeState({ working: false });

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		// No status recorded; taskState stays undefined so classification → completed.
		expect(state.summaryState).toBeUndefined();
	});

	test("discards a verdict when a new turn arrives during the model call", async () => {
		vi.useFakeTimers();
		const state = makeState({ working: false });
		// The model "responds" only after the session has moved on to a new turn.
		const generate = vi.fn().mockImplementation(async () => {
			(state.runtime.session.messages as unknown[]).push({ role: "user", content: "another task" });
			return { summary: "Stale summary for the old turn", taskState: "completed" };
		});
		const summarizer = new DaemonSessionSummarizer(() => [], undefined, generate);

		summarizer.notifyActivity(state);
		await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
		expect(generate).toHaveBeenCalledOnce();
		// Result is for an outdated turn → dropped, nothing persisted.
		expect(state.summaryState).toBeUndefined();
	});
});
