import type { ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean;
	_createKernelHostHandlers: () => Record<string, unknown>;
};

function createAssistant(harness: Harness, options: { stopReason?: AssistantMessage["stopReason"] } = {}) {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", { stopReason: options.stopReason, timestamp: Date.now() }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

/** Extension that supplies compaction content so no provider call is needed. */
function extensionCompaction() {
	return (pi: any) => {
		pi.on("session_before_compact", async (event: any) => ({
			compaction: {
				summary: "requested summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
}

describe("AgentSession compact skill host requests", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("schedules via compact.run and compacts at the turn boundary with reason requested", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const runResult = harness.session.handleCompactHostRequest("compact.run", { instructions: "keep the plan" });
		expect(runResult.scheduled).toBe(true);
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(true);

		const internals = harness.session as unknown as SessionInternals;
		const compacted = await internals._checkCompaction(createAssistant(harness));
		expect(compacted).toBe(false); // no retry needed

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({
			reason: "requested",
			customInstructions: "keep the plan",
		});
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "requested" });
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
	});

	it("reports skipped when there is nothing to compact", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const result = harness.session.handleCompactHostRequest("compact.run");
		expect(result).toEqual({ scheduled: false, reason: "session is too short to compact" });
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
	});

	it("runs a requested compaction even when auto-compaction is disabled", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);

		const internals = harness.session as unknown as SessionInternals;
		expect(internals._shouldStopAfterTurn({ message: createAssistant(harness) } as ShouldStopAfterTurnContext)).toBe(
			true,
		);
		await internals._checkCompaction(createAssistant(harness));

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(1);
	});

	it("drops a pending requested compaction when the turn is aborted", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(harness.session.handleCompactHostRequest("compact.run").scheduled).toBe(true);

		const internals = harness.session as unknown as SessionInternals;
		const compacted = await internals._checkCompaction(createAssistant(harness, { stopReason: "aborted" }));
		expect(compacted).toBe(false);
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("reports context usage via compact.status", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const status = harness.session.handleCompactHostRequest("compact.status");
		expect(status.scheduled).toBe(false);
		expect(status.context_window).not.toBeNull();
	});

	it("is gated by the compaction.agentCallable setting", async () => {
		const harness = await createHarness({ settings: { compaction: { agentCallable: false } } });
		harnesses.push(harness);

		expect(() => harness.session.handleCompactHostRequest("compact.run")).toThrow(
			"the compact skill is disabled in this session",
		);
		const internals = harness.session as unknown as SessionInternals;
		expect(Object.keys(internals._createKernelHostHandlers())).not.toContain("compact.run");

		const enabledHarness = await createHarness();
		harnesses.push(enabledHarness);
		const enabledInternals = enabledHarness.session as unknown as SessionInternals;
		expect(Object.keys(enabledInternals._createKernelHostHandlers())).toEqual(
			expect.arrayContaining(["compact.run", "compact.status"]),
		);
	});
});
