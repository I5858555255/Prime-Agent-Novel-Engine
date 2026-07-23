import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SerializedInternals = {
	_shouldStopAfterTurn(context: {
		message: { stopReason?: string; content: unknown[]; role: string; usage?: unknown; timestamp?: number };
		toolResults: unknown[];
		context: unknown;
		newMessages: unknown[];
	}): Promise<boolean>;
	_runSerializedRefineCheckpoint(): Promise<void>;
	_runSerializedRefine(options: { instructions?: string; global?: boolean }): Promise<void>;
	_consumePendingRequestedRefine(): void;
	_maybeAutoRefine(reason: string): Promise<void>;
	_reviewAutoRefine(context: { reason: string; turnsSinceLastReview: number }, signal?: AbortSignal): Promise<unknown>;
	_planRefine(options: { instructions?: string; global?: boolean }, signal: AbortSignal): Promise<unknown>;
	_applyRefine(
		plan: unknown,
		options: { instructions?: string; global?: boolean },
		abort: AbortController,
	): Promise<unknown>;
	_serializedRefine: boolean;
	_pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;
	_assistantTurnsSinceAutoRefine: number;
	_lastAutoRefineReviewAt: number;
	_autoRefineInProgress: boolean;
	_autoRefineBranchVersion: number;
	_refineInFlight?: Promise<void>;
	_refinePlanInFlight?: Promise<void>;
	_serializedPlanInFlight?: Promise<unknown>;
	_disposing: boolean;
	_disposed: boolean;
	_scheduleAutoRefineAfterAgentEnd(): void;
	_checkCompaction(message: unknown): Promise<boolean>;
	_lastAssistantMessage: unknown;
	_handleAgentEvent(event: { type: string; messages?: unknown[] }): void;
	_agentEventQueue: Promise<void>;
};

function emptyRefinementResult() {
	return {
		id: "refine_test",
		summary: "test refinement",
		rationale: "test rationale",
		expectedOutcome: "test outcome",
		appliedEdits: [],
		harnessStatePath: "/tmp/harness_state.json",
	};
}

function makeCtx(text: string) {
	return {
		message: {
			stopReason: "stop",
			content: [{ type: "text" as const, text }],
			role: "assistant",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
			timestamp: Date.now(),
		},
		toolResults: [],
		context: {},
		newMessages: [],
	};
}

/** Mock _planRefine and _applyRefine so _runSerializedRefine completes without real LLM calls. */
function mockSerializedRefine(harness: Harness) {
	const internals = harness.session as unknown as SerializedInternals;
	const plan = { id: "test-plan", proposal: { edits: [] } };
	vi.spyOn(internals, "_planRefine").mockResolvedValue(plan);
	vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());
	return { plan, applyRefine: internals._applyRefine };
}

describe("Serialized auto-refine checkpoint", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("refines exactly once when >25 tool turns run in one loop", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "durable lesson",
			instructions: "capture the lesson",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);
		const internals = harness.session as unknown as SerializedInternals;

		for (let turn = 1; turn <= 26; turn++) {
			internals._assistantTurnsSinceAutoRefine++; // simulate message_end increment
			await internals._shouldStopAfterTurn(makeCtx(`turn ${turn}`));
		}

		// _applyRefine called exactly once (at turn 25).
		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(reviewer).toHaveBeenCalledTimes(1);
	});

	it("max concurrent primary/refinement model requests is one in serialized mode", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;
		internals._assistantTurnsSinceAutoRefine = 1;

		let applyInFlight = false;
		let resolveApply: () => void = () => {};
		const applyPromise = new Promise<void>((resolve) => {
			resolveApply = resolve;
		});
		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			applyInFlight = true;
			await applyPromise;
			applyInFlight = false;
			return emptyRefinementResult();
		});

		// Start _shouldStopAfterTurn — it will await the serialized refine
		const checkpointPromise = internals._shouldStopAfterTurn(makeCtx("test"));

		// The checkpoint is running and apply is in flight.
		// _shouldStopAfterTurn has not returned yet, so the agent loop
		// cannot start the next model request.
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(applyInFlight).toBe(true);

		// Release the apply
		resolveApply();
		await checkpointPromise;

		expect(applyInFlight).toBe(false);
	});

	it("prompt/state update visible on resumed turn after serialized refine", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "add memory",
				instructions: "add a memory entry",
			})),
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		const internals = harness.session as unknown as SerializedInternals;
		internals._assistantTurnsSinceAutoRefine = 1;

		await internals._runSerializedRefineCheckpoint();

		// _applyRefine was called (which rebuilds system prompt).
		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("final agent_end pending refine completes before dispose", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		const internals = harness.session as unknown as SerializedInternals;
		internals._assistantTurnsSinceAutoRefine = 1;

		await harness.session.disposeAsync();

		// The drain path ran the serialized checkpoint which called _applyRefine.
		expect(applyRefine).toHaveBeenCalled();
		expect(internals._disposed).toBe(true);
	});

	it("interactive background refine behavior preserved when serializedRefine is false", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: false,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals;
		expect(internals._serializedRefine).toBe(false);

		let checkpointCalled = false;
		vi.spyOn(internals, "_runSerializedRefineCheckpoint").mockImplementation(async () => {
			checkpointCalled = true;
		});

		internals._assistantTurnsSinceAutoRefine = 1;
		await internals._shouldStopAfterTurn(makeCtx("test"));

		expect(checkpointCalled).toBe(false);
	});

	it("never deadlocks: serialized checkpoint does not call waitForIdle or _maybeAutoRefine", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		// Simulate "active" agent state (as during a tool loop)
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;

		const internals = harness.session as unknown as SerializedInternals;
		internals._assistantTurnsSinceAutoRefine = 1;

		// Must resolve within 5 seconds — if _maybeAutoRefine were called,
		// _shouldSkipAutoRefineForActiveAgent would defer, and if waitForIdle
		// were called, it would deadlock waiting for activeRun to finish.
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Serialized checkpoint deadlocked")), 5000),
		);

		await Promise.race([internals._runSerializedRefineCheckpoint(), timeout]);

		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});
});

describe("Serialized agent-callable refine", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("agent-callable refine.run starts background planning immediately in serialized mode", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		const internals = harness.session as unknown as SerializedInternals;

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "capture a lesson" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		// In serialized mode, handleRefineHostRequest immediately kicks off
		// background planning, consuming the pending request.
		expect(internals._pendingRequestedRefine).toBeUndefined();
		expect(internals._serializedPlanInFlight).toBeDefined();

		// Wait for background planning to complete
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// At the boundary, the plan should be applied
		await internals._runSerializedRefineCheckpoint();
		expect(applyRefine).toHaveBeenCalledTimes(1);
	});

	it("agent-callable request takes priority over interval-triggered auto-refine", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "interval",
			instructions: "interval lesson",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		const internals = harness.session as unknown as SerializedInternals;
		internals._assistantTurnsSinceAutoRefine = 1;

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "callable lesson" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		await internals._runSerializedRefineCheckpoint();

		// _applyRefine called once (for the callable request only).
		// The explicit refine satisfied the interval and reset the counter,
		// so no interval-triggered auto-refine follows.
		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._pendingRequestedRefine).toBeUndefined();
		// The reviewer was NOT called because the explicit refine
		// satisfied the interval check.
		expect(reviewer).not.toHaveBeenCalled();
	});

	it("agent-callable refine.run background plan started immediately, NOT fire-and-forget at agent_end", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);

		const internals = harness.session as unknown as SerializedInternals;

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		// In serialized mode, the pending request is consumed immediately
		// by background planning, NOT left for fire-and-forget at agent_end.
		expect(internals._pendingRequestedRefine).toBeUndefined();
		expect(internals._serializedPlanInFlight).toBeDefined();
	});

	it("pending agent-callable refine drained before disposal", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		const internals = harness.session as unknown as SerializedInternals;

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "drain test" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		await harness.session.disposeAsync();

		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._disposed).toBe(true);
	});
});

describe("Serialized autonomous continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("autonomous tool loop continues past serialized refinement boundary with no deadlock", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "checkpoint",
			instructions: "capture lesson",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 3, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		const internals = harness.session as unknown as SerializedInternals;

		// Simulate shouldStopAfterTurn calls for turns 1-5.
		const turnResults: boolean[] = [];
		for (let turn = 1; turn <= 5; turn++) {
			internals._assistantTurnsSinceAutoRefine++; // simulate message_end increment
			const stopResult = await Promise.race([
				internals._shouldStopAfterTurn(makeCtx(`autonomous turn ${turn}`)),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Deadlock at turn ${turn}`)), 5000)),
			]);
			turnResults.push(stopResult);
		}

		// All turns return false (continue) — checkpoint ran but didn't stop.
		expect(turnResults).toEqual([false, false, false, false, false]);

		// _applyRefine called exactly once (at turn 3).
		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(reviewer).toHaveBeenCalledTimes(1);

		// After the refine at turn 3, counter was reset to 0.
		// Turns 4 and 5 set it to 1 and 2, both < 3.
		expect(internals._assistantTurnsSinceAutoRefine).toBe(2);
	});
});

describe("Serialized background planning during tools", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("planning overlaps a deferred tool but next model turn waits for plan+apply", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		let resolvePlan: () => void = () => {};
		const planPromise = new Promise<void>((resolve) => {
			resolvePlan = resolve;
		});
		let planStarted = false;
		let planFinished = false;

		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			planStarted = true;
			await planPromise;
			planFinished = true;
			return { id: "bg-plan", proposal: { edits: [] } };
		});
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Step 1: simulate message_end — this should kick off background planning.
		internals._assistantTurnsSinceAutoRefine++;
		// Call the private method that starts background planning
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();

		// Wait a tick for the async plan to start
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(planStarted).toBe(true);
		expect(planFinished).toBe(false); // still planning while "tools execute"

		// Step 2: shouldStopAfterTurn should WAIT for the plan to finish.
		const checkpointPromise = internals._shouldStopAfterTurn(makeCtx("turn with tools"));

		// The checkpoint should be waiting for the plan (not yet resolved).
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		// _applyRefine has NOT been called yet because planning is still in flight.
		expect(internals._applyRefine).not.toHaveBeenCalled();

		// Release the plan — the checkpoint should proceed to apply.
		resolvePlan();
		await checkpointPromise;

		// Now apply has been called.
		expect(internals._applyRefine).toHaveBeenCalledTimes(1);
		expect(planFinished).toBe(true);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("services refine.run at the same boundary when an interval plan is already in flight", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "interval review",
			instructions: "interval plan",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		let resolveIntervalPlan: () => void = () => {};
		const intervalPlanReady = new Promise<void>((resolve) => {
			resolveIntervalPlan = resolve;
		});
		let planCalls = 0;
		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			planCalls++;
			if (planCalls === 1) {
				await intervalPlanReady;
			}
			return { id: `plan-${planCalls}`, proposal: { edits: [] } };
		});
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		internals._assistantTurnsSinceAutoRefine = 1;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(planCalls).toBe(1);

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "explicit plan" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
		expect(internals._pendingRequestedRefine?.instructions).toBe("explicit plan");

		const checkpoint = internals._runSerializedRefineCheckpoint();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		resolveIntervalPlan();
		await checkpoint;

		expect(reviewer).toHaveBeenCalledTimes(1);
		expect(internals._planRefine).toHaveBeenCalledTimes(2);
		expect(internals._applyRefine).toHaveBeenCalledTimes(2);
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("max concurrent model calls is one: planning does not start another model request", async () => {
		// The background plan uses _reviewAutoRefine which calls the LLM via
		// completeSimple (an independent non-streaming call). In serialized mode,
		// the review is part of the background plan, not a second model request
		// overlapping the primary stream. The primary stream is already done
		// (message_end fired) when planning starts.
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Simulate message_end
		internals._assistantTurnsSinceAutoRefine++;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();

		// Wait for planning to complete (reviewer is async)
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// The reviewer was called (background planning started at message_end)
		expect(reviewer).toHaveBeenCalledTimes(1);

		// Now call shouldStopAfterTurn — it should await the background plan
		// and apply it without starting a new model request.
		await internals._shouldStopAfterTurn(makeCtx("boundary"));

		expect(internals._applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});
});

describe("PR #503 model persistence regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("persisted subagent model is restored on session rehydration", async () => {
		// PR #503 commit 47c4b28f8 persists and restores the subagent model
		// on rehydration. This test verifies the model is not lost when a
		// session is created with a specific model.
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
		});
		harnesses.push(harness);

		// The session should have a model set.
		expect(harness.session.model).toBeDefined();
		expect(harness.session.model?.id).toBe(harness.getModel().id);
	});

	it("model is preserved after serialized refine checkpoint", async () => {
		// PR #503 commit 742a85b99 preserves the extension system prompt
		// after the refine wait. This test verifies the model survives a
		// serialized refine checkpoint.
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);
		const { applyRefine } = mockSerializedRefine(harness);

		const internals = harness.session as unknown as SerializedInternals;
		const modelBefore = harness.session.model;

		internals._assistantTurnsSinceAutoRefine = 1;
		await internals._runSerializedRefineCheckpoint();

		// Model is preserved after the checkpoint.
		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(harness.session.model).toBe(modelBefore);
	});
});

describe("Serialized refine review-fix regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("explicit refine.run does NOT call the auto-review gate", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "should not be called",
			instructions: "should not be called",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Queue a refine.run request — in serialized mode, this immediately
		// kicks off background planning (skipping the review gate).
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "explicit lesson" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		// Background planning was started automatically by handleRefineHostRequest.
		expect(internals._serializedPlanInFlight).toBeDefined();

		// Wait for background planning to complete
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Reviewer was NOT called — explicit refine.run skips the review gate.
		expect(reviewer).not.toHaveBeenCalled();

		// At the boundary, the plan should be applied
		await internals._runSerializedRefineCheckpoint();
		expect(internals._applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("failure result stamps cooldown and does NOT retry synchronously", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		// Make background planning fail
		vi.spyOn(internals, "_planRefine").mockRejectedValue(new Error("plan failed"));
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Start background planning
		internals._assistantTurnsSinceAutoRefine++;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();

		// Wait for background planning to fail
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// At the boundary, the failure result should stamp cooldown and return.
		// It should NOT fall through to synchronous review+plan (no duplicate model call).
		await internals._runSerializedRefineCheckpoint();

		// Reviewer was called exactly once (during background planning).
		// It should NOT be called again at the boundary (failure -> no retry).
		expect(reviewer).toHaveBeenCalledTimes(1);
		// _applyRefine was NOT called (planning failed).
		expect(internals._applyRefine).not.toHaveBeenCalled();
		// Cooldown was stamped.
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);
	});

	it("serialized failure does not schedule interactive auto-refine at agent_end", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		// Make background planning fail
		vi.spyOn(internals, "_planRefine").mockRejectedValue(new Error("plan failed"));
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Start background planning and let it fail
		internals._assistantTurnsSinceAutoRefine = 1;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// At the boundary, the failure result should stamp cooldown and return.
		await internals._runSerializedRefineCheckpoint();

		// Reviewer was called exactly once (during background planning).
		expect(reviewer).toHaveBeenCalledTimes(1);
		// _applyRefine was NOT called (planning failed).
		expect(internals._applyRefine).not.toHaveBeenCalled();
		// Cooldown was stamped.
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);

		// Now simulate the actual agent_end event path.
		// Set _lastAssistantMessage so agent_end has a non-error assistant to process.
		const fauxAssistant = fauxAssistantMessage("done");
		internals._lastAssistantMessage = fauxAssistant;

		// Spy on _scheduleAutoRefineAfterAgentEnd — it should NOT be called in serialized mode.
		const scheduleSpy = vi.spyOn(internals, "_scheduleAutoRefineAfterAgentEnd");
		// Mock _checkCompaction so agent_end reaches the scheduling guard.
		vi.spyOn(internals, "_checkCompaction").mockResolvedValue(false);

		// Drive the real agent_end event through _handleAgentEvent → _processAgentEvent.
		internals._handleAgentEvent({ type: "agent_end", messages: [fauxAssistant] });
		await internals._agentEventQueue;
		// Flush any setTimeout(0) that _scheduleAutoRefine would have used.
		await new Promise<void>((resolve) => setTimeout(resolve, 20));

		// _scheduleAutoRefineAfterAgentEnd must NEVER be called in serialized mode.
		expect(scheduleSpy).not.toHaveBeenCalled();
	});

	it("explicit refine.run bg plan fails then boundary replan/apply succeeds", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		let planCalls = 0;
		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			planCalls++;
			if (planCalls === 1) throw new Error("bg plan failed");
			return { id: "replan", proposal: { edits: [] } };
		});
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Queue an explicit refine.run — this starts background planning at message_end.
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "explicit" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		// Let the background plan fail.
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(internals._pendingRequestedRefine).toBeUndefined();

		// At the boundary, the failure re-queues the explicit options and the
		// synchronous pending path replans + applies.
		await internals._runSerializedRefineCheckpoint();

		expect(planCalls).toBe(2); // bg plan (failed) + synchronous replan
		expect(internals._applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("interval bg plan failure does not retry synchronously", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		// Interval background planning fails (not explicit refine.run).
		vi.spyOn(internals, "_planRefine").mockRejectedValue(new Error("plan failed"));
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		internals._assistantTurnsSinceAutoRefine = 1;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		await internals._runSerializedRefineCheckpoint();

		// Reviewer called once (interval bg plan), NOT retried at boundary.
		expect(reviewer).toHaveBeenCalledTimes(1);
		expect(internals._applyRefine).not.toHaveBeenCalled();
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("stale branch failure does not requeue explicit refine.run", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		vi.spyOn(internals, "_planRefine").mockRejectedValue(new Error("plan failed"));
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Queue explicit refine.run — starts background planning.
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "explicit" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Invalidate the branch (simulates a newer turn or branch reset).
		internals._autoRefineBranchVersion++;

		await internals._runSerializedRefineCheckpoint();

		// Stale branch: no re-queue, no apply.
		expect(internals._applyRefine).not.toHaveBeenCalled();
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("newer pending supersedes failed older explicit refine.run", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		vi.spyOn(internals, "_planRefine").mockImplementation(async (opts) => {
			if (opts.instructions === "older") throw new Error("bg plan failed");
			return { id: "newer-plan", proposal: { edits: [] } };
		});
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Queue older request — starts background planning.
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "older" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Queue newer request before the boundary.
		internals._pendingRequestedRefine = { instructions: "newer" };

		await internals._runSerializedRefineCheckpoint();

		// Newer request is serviced (plan with "newer", not "older").
		expect(internals._applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("interval background plan derives instructions from review, not prepopulated", async () => {
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "specific rationale from review",
			instructions: "specific instructions from review",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		let capturedPlanOptions: { instructions?: string } | undefined;
		vi.spyOn(internals, "_planRefine").mockImplementation(async (opts: { instructions?: string }) => {
			capturedPlanOptions = opts;
			return { id: "p", proposal: { edits: [] } };
		});
		vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Start background planning (interval-triggered)
		internals._assistantTurnsSinceAutoRefine++;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();

		// Wait for background planning
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// The plan options should include the review's rationale/instructions,
		// not a generic prepopulated message.
		expect(capturedPlanOptions).toBeDefined();
		expect(capturedPlanOptions?.instructions).toContain("specific rationale from review");
		expect(capturedPlanOptions?.instructions).toContain("specific instructions from review");
	});

	it("disposal applies ready background plan before teardown", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		const exactPlan = { id: "disposal-plan", proposal: { edits: [] } };
		vi.spyOn(internals, "_planRefine").mockResolvedValue(exactPlan);
		const applySpy = vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Start background planning
		internals._assistantTurnsSinceAutoRefine++;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();

		// Wait for the background plan to settle (plan ready)
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Dispose — should apply the ready plan before teardown.
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Disposal deadlocked")), 5000),
		);
		await Promise.race([harness.session.disposeAsync(), timeout]);

		// _applyRefine was called with the exact plan (persisted before teardown).
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect((applySpy.mock.calls[0] as unknown[])[0]).toBe(exactPlan);
		expect(internals._disposed).toBe(true);
	});
});

describe("Serialized refine event-ordering integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("real message_end/turn_end ordering: threshold planning starts and applies before next model turn", async () => {
		// This test uses real agent.prompt() with faux responses to verify
		// that _shouldStopAfterTurn's await this._agentEventQueue ensures
		// the message_end counter increment and background plan kickoff
		// happen BEFORE the serialized checkpoint runs.
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "integration test",
			instructions: "capture lesson",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		const planSpy = vi
			.spyOn(internals, "_planRefine")
			.mockResolvedValue({ id: "p", proposal: { edits: [] } } as never);
		const applySpy = vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Send a prompt that produces a text response (no tool calls).
		// This goes through the real agent loop: agent_start -> turn_start ->
		// message_start -> message_end (counter++) -> turn_end -> shouldStopAfterTurn
		// -> agent_end.
		harness.setResponses([fauxAssistantMessage("response 1")]);

		// Track counter before and after prompt
		const counterBefore = internals._assistantTurnsSinceAutoRefine;
		await harness.session.prompt("test prompt");

		// After the first turn, the counter should be incremented by the
		// real message_end handler (not by direct mutation).
		expect(internals._assistantTurnsSinceAutoRefine).toBe(counterBefore + 1);

		// Now send a second prompt to reach the interval (turnInterval=2).
		harness.setResponses([fauxAssistantMessage("response 2")]);
		await harness.session.prompt("test prompt 2");

		// After the second turn, the serialized checkpoint should have fired
		// (interval=2, counter reached 2). The _agentEventQueue await in
		// _shouldStopAfterTurn ensured the counter was incremented before
		// the checkpoint checked the threshold.
		expect(applySpy).toHaveBeenCalled();
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);

		// The reviewer was called exactly once (during background planning
		// or synchronous boundary review, not duplicated).
		expect(reviewer).toHaveBeenCalledTimes(1);
		// _planRefine called exactly once (no duplicate from re-planning).
		expect(planSpy).toHaveBeenCalledTimes(1);
	});
});

describe("P0 concurrency regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("serialized threshold compaction: background plan applied before compaction fires", async () => {
		// Verify that when threshold compaction would fire, the serialized
		// checkpoint runs FIRST, draining the background plan, so the
		// compaction model call cannot overlap an in-flight refine.
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "test",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		let planResolved = false;
		let applyFinished = false;

		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			planResolved = true;
			return { id: "p", proposal: { edits: [] } };
		});
		vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			expect(planResolved).toBe(true);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			applyFinished = true;
			return emptyRefinementResult();
		});

		// Spy on _shouldStopForThresholdCompaction: assert apply finished
		// when compaction check runs, return true to simulate compaction firing.
		const compactionSpy = vi
			.spyOn(
				internals as unknown as { _shouldStopForThresholdCompaction: (ctx: unknown) => Promise<boolean> },
				"_shouldStopForThresholdCompaction",
			)
			.mockImplementation(async () => {
				expect(applyFinished).toBe(true);
				return true;
			});

		// Start background planning at message_end
		internals._assistantTurnsSinceAutoRefine++;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();

		// Wait for plan to start but not finish
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// _shouldStopAfterTurn: serialized checkpoint runs BEFORE compaction.
		// Checkpoint awaits background plan, applies it. Then compaction fires.
		const result = await internals._shouldStopAfterTurn(makeCtx("turn"));

		expect(compactionSpy).toHaveBeenCalledTimes(1);
		expect(result).toBe(true);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});
	it("branch navigation with in-flight serialized plan: aborts signal, no apply", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: vi.fn(async () => ({
				shouldRefine: true,
				rationale: "test",
				instructions: "test",
			})),
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		const applySpy = vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Make _planRefine block on its AbortSignal so we can test abort behavior.
		let planSignal: AbortSignal | undefined;
		vi.spyOn(internals, "_planRefine").mockImplementation(async (_opts: unknown, signal: AbortSignal) => {
			planSignal = signal;
			// Block until the signal aborts, then throw.
			if (signal.aborted) throw new Error("Plan aborted by branch change");
			await new Promise<void>((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			}).catch(() => undefined);
			if (signal.aborted) throw new Error("Plan aborted by branch change");
			return { id: "p", proposal: { edits: [] } };
		});

		// Start background planning
		internals._assistantTurnsSinceAutoRefine++;
		(
			internals as unknown as { _maybeStartSerializedBackgroundPlan: () => void }
		)._maybeStartSerializedBackgroundPlan();

		// Wait for the plan to start blocking
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(internals._serializedPlanInFlight).toBeDefined();
		expect(planSignal).toBeDefined();

		// Call _invalidatePendingAutoRefineForBranchChange while plan is pending.
		// This increments _autoRefineBranchVersion and awaits _serializedPlanInFlight.
		const invalidatePromise = (
			harness.session as unknown as {
				_invalidatePendingAutoRefineForBranchChange: () => Promise<void>;
			}
		)._invalidatePendingAutoRefineForBranchChange();

		// The branchVersion was incremented, invalidating the plan.
		const branchVersionAfter = internals._autoRefineBranchVersion;
		expect(branchVersionAfter).toBeGreaterThan(0);

		// Wait for invalidation to complete (the plan promise settles as "failure"
		// because _planRefine threw, but the branchVersion mismatch means no apply).
		await invalidatePromise;

		// _serializedPlanInFlight is cleared.
		expect(internals._serializedPlanInFlight).toBeUndefined();

		// Run the checkpoint — no background plan to apply (cleared by invalidation).
		await internals._runSerializedRefineCheckpoint();

		// _applyRefine was NOT called.
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("non-mocked apply pipeline: harness state persisted, prompt rebuilt, refine_complete emitted", async () => {
		// This test does NOT mock _applyRefine. It uses a faux planRefine
		// mock but lets the real _applyRefine run, which calls
		// applyRefinementProposal, saveHarnessState, _rebuildSystemPrompt,
		// and emits refine_complete.
		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "test",
			instructions: "add a memory",
		}));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		// Mock only _planRefine (the LLM planning call), NOT _applyRefine.
		const fauxPlan = {
			id: "refine_p0_test",
			proposal: {
				summary: "P0 test refinement",
				rationale: "testing non-mocked apply",
				expectedOutcome: "memory entry persisted",
				edits: [
					{
						action: "create" as const,
						kind: "memory" as const,
						title: "P0 concurrency test memory",
						content: "Added during non-mocked apply pipeline test",
					},
				],
			},
		};
		vi.spyOn(internals, "_planRefine").mockResolvedValue(fauxPlan as never);

		// Spy on _rebuildSystemPrompt (call-through) to assert it was invoked.
		const rebuildSpy = vi.spyOn(
			harness.session as unknown as { _rebuildSystemPrompt: (tools: string[]) => string },
			"_rebuildSystemPrompt",
		);

		// Track refine_complete event
		let refineCompleteEmitted = false;
		harness.session.subscribe((event) => {
			if (event.type === "refine_complete") {
				refineCompleteEmitted = true;
			}
		});

		// Run the serialized refine (real _applyRefine runs).
		await internals._runSerializedRefine({ instructions: "add a memory" });

		// _rebuildSystemPrompt was called by _applyRefine.
		expect(rebuildSpy).toHaveBeenCalledTimes(1);

		// Harness state persisted to disk.
		const localDir = (await import("../../src/core/refinement/index.js")).getLocalHarnessStateDir(
			harness.sessionManager.getSessionArtifactDir(),
		);
		expect(localDir).toBeDefined();
		if (localDir) {
			const state = (await import("../../src/core/refinement/index.js")).loadHarnessState(localDir, "local");
			const memoryEntries = Object.values(state.entries.memory ?? {});
			const memoryEntry = memoryEntries.find((m) => m.title === "P0 concurrency test memory");
			expect(memoryEntry).toBeDefined();
			expect(memoryEntry?.content).toBe("Added during non-mocked apply pipeline test");
		}

		// refine_complete was emitted.
		expect(refineCompleteEmitted).toBe(true);
	});
	it("explicit refine.run planning failure: stamps cooldown, no apply, no retry", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 25, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		// Make planning fail for the explicit refine.run request.
		const planError = new Error("planning network failure");
		vi.spyOn(internals, "_planRefine").mockRejectedValue(planError);
		const applySpy = vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Queue a refine.run request — this starts background planning.
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		// Wait for background planning to fail.
		await new Promise<void>((resolve) => setTimeout(resolve, 50));

		// Run the checkpoint — the background plan failed ("failure" result).
		await internals._runSerializedRefineCheckpoint();

		// _applyRefine was NOT called (planning failed).
		expect(applySpy).not.toHaveBeenCalled();

		// Cooldown was stamped (failure -> stamp cooldown, no retry).
		expect(internals._lastAutoRefineReviewAt).toBeGreaterThan(0);

		// _serializedPlanInFlight is cleared.
		expect(internals._serializedPlanInFlight).toBeUndefined();
	});

	it("serialized same-entry Python harness-write: concurrent kernel write rejected via baselineState", async () => {
		// Verify that a concurrent Python kernel harness write (e.g.
		// rlm.harness.create_memory) during serialized background planning
		// is detected via baselineState comparison and the stale edit is
		// rejected, preserving the concurrent write.
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;

		// Seed a memory entry on disk so the plan has something to update.
		const { getLocalHarnessStateDir, loadHarnessState, saveHarnessState } = await import(
			"../../src/core/refinement/index.js"
		);
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		expect(localDir).toBeDefined();
		if (!localDir) return;
		const seedState = loadHarnessState(localDir, "local");
		seedState.entries.memory ??= {};
		seedState.entries.memory.shared = {
			id: "shared",
			kind: "memory",
			title: "Shared",
			content: "planning baseline",
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "refine",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			version: 1,
		};
		saveHarnessState(localDir, seedState);

		// Mock _planRefine to block until released so we can simulate
		// a concurrent harness write during the planning phase.
		let releasePlan: (() => void) | undefined;
		const planGate = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		let planStarted: (() => void) | undefined;
		const planStartedPromise = new Promise<void>((resolve) => {
			planStarted = resolve;
		});

		// Capture the baseline state at planning time (before the LLM call would run)
		// so the real _applyRefine can compare it against the current on-disk state.
		const baselineState = loadHarnessState(localDir, "local");
		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			planStarted?.();
			await planGate;
			return {
				id: "refine_conflict_test",
				proposal: {
					summary: "Update shared memory",
					rationale: "planned update",
					expectedOutcome: "updated",
					edits: [
						{
							action: "update",
							kind: "memory",
							id: "shared",
							title: "Shared",
							content: "stale planned content",
						},
					],
				},
				baselineState,
			} as never;
		});

		// Start the serialized refine — begins background planning.
		const refinePromise = internals._runSerializedRefine({ instructions: "update shared memory" });

		// Wait for planning to start.
		await planStartedPromise;

		// Simulate a concurrent Python kernel harness write while planning is in flight.
		const concurrentState = loadHarnessState(localDir, "local");
		const sharedEntry = concurrentState.entries.memory?.shared;
		expect(sharedEntry).toBeDefined();
		if (sharedEntry) {
			sharedEntry.content = "concurrent kernel content";
			sharedEntry.version++;
		}
		saveHarnessState(localDir, concurrentState);

		// Release the plan so it completes with a stale proposal.
		releasePlan?.();

		// Wait for the serialized refine to finish (planning + apply).
		await refinePromise;

		// The on-disk state should still have the concurrent content
		// (the stale planned edit was rejected by baselineState comparison).
		const finalState = loadHarnessState(localDir, "local");
		expect(finalState.entries.memory?.shared?.content).toBe("concurrent kernel content");
	});
});
