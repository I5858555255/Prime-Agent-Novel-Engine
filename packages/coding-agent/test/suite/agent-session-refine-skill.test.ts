import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_consumePendingRequestedRefine: () => boolean;
	_emitRefineFailed: (error: unknown) => void;
	_pendingRequestedRefine: { instructions?: string; global?: boolean; planId?: string } | undefined;
	_serializedPlanInFlight?: Promise<unknown>;
	_serializedExplicitRefineOptions?: { instructions?: string; global?: boolean };
	_refineAbortController?: AbortController;
	_createKernelHostHandlers: () => Record<string, unknown>;
	refine: (options: { instructions?: string; global?: boolean; planId?: string }) => Promise<unknown>;
	_planRefine: (options: { instructions?: string; global?: boolean }, signal: AbortSignal) => Promise<unknown>;
	_previewedPlans: Map<string, { plan: unknown; options: unknown; branchVersion: number }>;
	_getPreviewedPlan: (planId: string) => { entry?: { plan: unknown; options: unknown }; reason?: string };
	_autoRefineBranchVersion: number;
	_applyRefine: (plan: unknown, options: unknown, abort: AbortController) => Promise<unknown>;
	_maybeStartSerializedBackgroundPlan: () => void;
	_scheduleAutoRefineAfterCompaction: (willContinue: boolean) => void;
};

function setStreaming(harness: Harness, streaming: boolean) {
	(harness.session.agent.state as { isStreaming: boolean }).isStreaming = streaming;
}

describe("AgentSession refine skill host requests", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("schedules via refine.run and reports pending via refine.status", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		const runResult = harness.session.handleRefineHostRequest("refine.run", { instructions: "test instructions" });
		setStreaming(harness, false);
		expect(runResult.scheduled).toBe(true);
		expect(runResult.note).toBeDefined();

		const status = harness.session.handleRefineHostRequest("refine.status");
		expect(status.pending).toBe(true);
	});

	it("stores global flag from refine.run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { global: true });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		expect(internals._pendingRequestedRefine?.global).toBe(true);
	});

	it("defaults to local scope when global is not provided", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run");
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		expect(internals._pendingRequestedRefine?.global).toBeUndefined();
		expect(internals._pendingRequestedRefine?.instructions).toBeUndefined();
	});

	it("updates pending request when called again", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "first", global: true });
		harness.session.handleRefineHostRequest("refine.run", { instructions: "second" });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		expect(internals._pendingRequestedRefine?.instructions).toBe("second");
		expect(internals._pendingRequestedRefine?.global).toBe(true);
	});

	it("replaces an in-flight serialized plan instead of applying both requests", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		const abort = new AbortController();
		internals._serializedPlanInFlight = new Promise(() => {});
		internals._serializedExplicitRefineOptions = { instructions: "first", global: true };
		internals._refineAbortController = abort;

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "replacement" });
		setStreaming(harness, false);

		expect(abort.signal.aborted).toBe(true);
		expect(internals._pendingRequestedRefine).toEqual({ instructions: "replacement", global: true });
	});

	it("discards a settled serialized plan when a replacement request arrives", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		internals._serializedPlanInFlight = Promise.resolve({ status: "plan" });
		internals._serializedExplicitRefineOptions = { instructions: "first", global: true };

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "replacement" });
		setStreaming(harness, false);

		await expect(internals._serializedPlanInFlight).resolves.toEqual({
			status: "invalidated",
			branchVersion: expect.any(Number),
		});
		expect(internals._pendingRequestedRefine).toEqual({ instructions: "replacement", global: true });
	});

	it("rejects refine.run while no turn is active", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = harness.session.handleRefineHostRequest("refine.run");
		expect(result.scheduled).toBe(false);
		expect(result.reason).toContain("no active turn");
		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(false);
	});

	it("validates instructions type in refine.run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		setStreaming(harness, true);
		expect(() =>
			harness.session.handleRefineHostRequest("refine.run", { instructions: 123 as unknown as string }),
		).toThrow("instructions must be a string");
		setStreaming(harness, false);
	});

	it("validates global flag type in refine.run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		setStreaming(harness, true);
		expect(() =>
			harness.session.handleRefineHostRequest("refine.run", { global: "yes" as unknown as boolean }),
		).toThrow("global must be a boolean");
		setStreaming(harness, false);
	});

	it("reports in_flight as false when no refine is active", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const status = harness.session.handleRefineHostRequest("refine.status");
		expect(status.in_flight).toBe(false);
		expect(status.pending).toBe(false);
	});

	it("consumes pending refine request at turn boundary", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		const refineSpy = vi.spyOn(internals, "refine").mockResolvedValue({});
		internals._consumePendingRequestedRefine();
		expect(refineSpy).toHaveBeenCalledWith({ instructions: "test", global: undefined });
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("does nothing when no pending refine at turn boundary", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const refineSpy = vi.spyOn(internals, "refine").mockResolvedValue({});
		expect(internals._consumePendingRequestedRefine()).toBe(false);
		expect(refineSpy).not.toHaveBeenCalled();
	});

	it("catches errors from refine at turn boundary without throwing", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		setStreaming(harness, false);

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "refine").mockRejectedValue(new Error("refine failed"));
		const failed = new Promise<string>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "refine_failed") {
					unsubscribe();
					resolve(event.error);
				}
			});
		});

		expect(internals._consumePendingRequestedRefine()).toBe(true);
		expect(await failed).toBe("refine failed");
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("continues notifying refine listeners after one throws", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionInternals;
		const observed: string[] = [];
		harness.session.subscribe(() => {
			throw new Error("broken listener");
		});
		harness.session.subscribe((event) => {
			if (event.type === "refine_failed") {
				observed.push(event.error);
			}
		});

		expect(() => internals._emitRefineFailed(new Error("planning failed"))).not.toThrow();
		expect(observed).toEqual(["planning failed"]);
	});

	it("registers refine.run and refine.status handlers when auto-refine is allowed", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const handlerKeys = Object.keys(internals._createKernelHostHandlers());
		expect(handlerKeys).toEqual(expect.arrayContaining(["refine.run", "refine.status"]));
	});

	it("does not register refine handlers when auto-refine is not allowed (rlmDepth > 0)", async () => {
		const harness = await createHarness({ persistSession: true, rlmDepth: 1 });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const handlerKeys = Object.keys(internals._createKernelHostHandlers());
		expect(handlerKeys).not.toContain("refine.run");
		expect(handlerKeys).not.toContain("refine.status");
	});

	it("does not register refine handlers without a persisted session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const handlerKeys = Object.keys(internals._createKernelHostHandlers());
		expect(handlerKeys).not.toContain("refine.run");
		expect(handlerKeys).not.toContain("refine.status");
	});

	it("clears pending refine on dispose", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test" });
		setStreaming(harness, false);

		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(true);
		harness.session.dispose();
		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(false);
	});

	it("rejects unknown refine request type", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		expect(() => harness.session.handleRefineHostRequest("refine.unknown")).toThrow(
			'unknown refine request type "refine.unknown"',
		);
	});

	function fakePlan(id: string) {
		return {
			id,
			proposal: {
				summary: `summary ${id}`,
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "t", content: "c", reason: "why" }],
			},
		};
	}

	it("refine.preview returns the serialized plan without scheduling or applying", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const planSpy = vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_a"));

		const payload = await harness.session.handleRefinePreviewHostRequest({ instructions: "focus" });
		expect(planSpy).toHaveBeenCalledWith({ instructions: "focus", global: undefined }, expect.any(AbortSignal));
		expect(payload.plan_id).toBe("refine_a");
		expect(payload.scope).toBe("local");
		expect(payload.edits).toEqual([
			{ action: "create", kind: "memory", id: null, title: "t", content: "c", reason: "why" },
		]);
		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(false);
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("refine.preview caches the plan and reports it in refine.status", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_b"));
		await harness.session.handleRefinePreviewHostRequest({ global: true });

		const status = harness.session.handleRefineHostRequest("refine.status");
		expect(status.previewed_plans).toEqual(["refine_b"]);
		expect(internals._previewedPlans.get("refine_b")?.options).toEqual({ instructions: undefined, global: true });
	});

	it("refine.preview keeps at most 5 cached plans, evicting the oldest", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const spy = vi.spyOn(internals, "_planRefine");
		for (let i = 0; i < 6; i++) {
			spy.mockResolvedValueOnce(fakePlan(`refine_${i}`));
			await harness.session.handleRefinePreviewHostRequest();
		}
		expect([...internals._previewedPlans.keys()]).toEqual([
			"refine_1",
			"refine_2",
			"refine_3",
			"refine_4",
			"refine_5",
		]);
	});

	it("refine.preview validates argument types", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		await expect(
			harness.session.handleRefinePreviewHostRequest({ instructions: 5 as unknown as string }),
		).rejects.toThrow("instructions must be a string");
		await expect(
			harness.session.handleRefinePreviewHostRequest({ global: "yes" as unknown as boolean }),
		).rejects.toThrow("global must be a boolean");
	});

	it("refine.status reports the pending request content", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		harness.session.handleRefineHostRequest("refine.run", { instructions: "test", global: true });
		setStreaming(harness, false);

		const status = harness.session.handleRefineHostRequest("refine.status");
		expect(status.pending).toBe(true);
		expect(status.pending_request).toEqual({ instructions: "test", global: true });
	});

	it("refine.status reports pending_request null when nothing is pending", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const status = harness.session.handleRefineHostRequest("refine.status");
		expect(status.pending_request).toBeNull();
		expect(status.previewed_plans).toEqual([]);
	});

	it("registers refine.preview alongside refine.run and refine.status", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const handlerKeys = Object.keys(internals._createKernelHostHandlers());
		expect(handlerKeys).toContain("refine.preview");
	});

	it("wires refine.preview's plan call into _refineAbortController so dispose cancels it", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "_planRefine").mockImplementation(
			(_options, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);

		const previewPromise = harness.session.handleRefinePreviewHostRequest({ instructions: "focus" });
		await vi.waitFor(() => expect(internals._refineAbortController).toBeInstanceOf(AbortController));

		harness.session.dispose();

		await expect(previewPromise).rejects.toThrow("aborted");
		expect(internals._refineAbortController).toBeUndefined();
	});

	it("refine.preview waits for an in-flight serialized background plan before planning", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		let releaseBackgroundPlan: () => void = () => {};
		internals._serializedPlanInFlight = new Promise<void>((resolve) => {
			releaseBackgroundPlan = resolve;
		});
		const backgroundAbort = new AbortController();
		internals._refineAbortController = backgroundAbort;
		const planSpy = vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_waits"));

		const previewPromise = harness.session.handleRefinePreviewHostRequest({ instructions: "focus" });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(planSpy).not.toHaveBeenCalled();
		expect(internals._refineAbortController).toBe(backgroundAbort);

		releaseBackgroundPlan();
		const payload = await previewPromise;
		expect(payload.plan_id).toBe("refine_waits");
		expect(planSpy).toHaveBeenCalledTimes(1);
	});

	it("refine.run with plan_id schedules the pinned plan", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_pin"));
		await harness.session.handleRefinePreviewHostRequest({ instructions: "focus", global: true });

		setStreaming(harness, true);
		const result = harness.session.handleRefineHostRequest("refine.run", { plan_id: "refine_pin" });
		setStreaming(harness, false);

		expect(result.scheduled).toBe(true);
		expect(internals._pendingRequestedRefine).toEqual({ instructions: "focus", global: true, planId: "refine_pin" });
	});

	it("refine.run with unknown plan_id is rejected without scheduling", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		setStreaming(harness, true);
		const result = harness.session.handleRefineHostRequest("refine.run", { plan_id: "refine_nope" });
		setStreaming(harness, false);

		expect(result.scheduled).toBe(false);
		expect(result.reason).toContain("unknown or expired");
		expect(harness.session.handleRefineHostRequest("refine.status").pending).toBe(false);
	});

	it("refine.run with a plan_id from before a branch change is rejected", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_stale"));
		await harness.session.handleRefinePreviewHostRequest();
		internals._autoRefineBranchVersion++;

		setStreaming(harness, true);
		const result = harness.session.handleRefineHostRequest("refine.run", { plan_id: "refine_stale" });
		setStreaming(harness, false);

		expect(result.scheduled).toBe(false);
		expect(result.reason).toContain("invalidated");
		expect(internals._previewedPlans.has("refine_stale")).toBe(false);
		expect(internals._pendingRequestedRefine).toBeUndefined();
	});

	it("keeps a pinned plan valid when refine.run invalidates an in-flight serialized plan", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const plan = fakePlan("refine_pin_inflight");
		const planSpy = vi.spyOn(internals, "_planRefine").mockResolvedValue(plan);
		await harness.session.handleRefinePreviewHostRequest({ instructions: "focus" });
		planSpy.mockClear();

		const backgroundAbort = new AbortController();
		internals._serializedPlanInFlight = new Promise(() => {});
		internals._refineAbortController = backgroundAbort;

		setStreaming(harness, true);
		const result = harness.session.handleRefineHostRequest("refine.run", { plan_id: "refine_pin_inflight" });
		setStreaming(harness, false);

		expect(result.scheduled).toBe(true);
		expect(backgroundAbort.signal.aborted).toBe(true);
		expect(internals._getPreviewedPlan("refine_pin_inflight").entry?.plan).toBe(plan);

		// The invalidated in-flight plan is dropped by its consumer; the pin then
		// resolves on the next background kick without re-planning.
		internals._serializedPlanInFlight = undefined;
		internals._refineAbortController = undefined;
		internals._maybeStartSerializedBackgroundPlan();
		expect(planSpy).not.toHaveBeenCalled();
		await expect(internals._serializedPlanInFlight).resolves.toMatchObject({ status: "plan", plan });
	});

	it("keeps the second pinned plan valid when refine.run pins twice in one turn", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const planA = fakePlan("refine_pin_a");
		const planB = fakePlan("refine_pin_b");
		const planSpy = vi.spyOn(internals, "_planRefine");
		planSpy.mockResolvedValueOnce(planA).mockResolvedValueOnce(planB);
		await harness.session.handleRefinePreviewHostRequest();
		await harness.session.handleRefinePreviewHostRequest();
		planSpy.mockClear();

		setStreaming(harness, true);
		const first = harness.session.handleRefineHostRequest("refine.run", { plan_id: "refine_pin_a" });
		const second = harness.session.handleRefineHostRequest("refine.run", { plan_id: "refine_pin_b" });
		setStreaming(harness, false);

		expect(first.scheduled).toBe(true);
		expect(second.scheduled).toBe(true);
		expect(internals._pendingRequestedRefine?.planId).toBe("refine_pin_b");
		expect(internals._getPreviewedPlan("refine_pin_b").entry?.plan).toBe(planB);

		internals._serializedPlanInFlight = undefined;
		internals._refineAbortController = undefined;
		internals._maybeStartSerializedBackgroundPlan();
		expect(planSpy).not.toHaveBeenCalled();
		await expect(internals._serializedPlanInFlight).resolves.toMatchObject({ status: "plan", plan: planB });
	});

	it("validates plan_id type in refine.run", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		setStreaming(harness, true);
		expect(() => harness.session.handleRefineHostRequest("refine.run", { plan_id: 7 as unknown as string })).toThrow(
			"plan_id must be a string",
		);
		setStreaming(harness, false);
	});

	it("refine with planId applies the cached plan without re-planning", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const plan = fakePlan("refine_apply");
		const planSpy = vi.spyOn(internals, "_planRefine").mockResolvedValue(plan);
		await harness.session.handleRefinePreviewHostRequest({ global: true });
		planSpy.mockClear();

		const applySpy = vi
			.spyOn(internals, "_applyRefine")
			.mockResolvedValue({ id: "refine_apply", summary: "s", appliedEdits: [] });
		await internals.refine({ planId: "refine_apply" });

		expect(planSpy).not.toHaveBeenCalled();
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(applySpy.mock.calls[0][0]).toBe(plan);
		expect((applySpy.mock.calls[0][1] as { global?: boolean }).global).toBe(true);
	});

	it("refine with an unknown planId throws with the reason", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		await expect(internals.refine({ planId: "refine_missing" })).rejects.toThrow("unknown or expired");
	});

	it("serialized background kick resolves a pinned plan without planning", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const plan = fakePlan("refine_ser");
		const planSpy = vi.spyOn(internals, "_planRefine").mockResolvedValue(plan);
		await harness.session.handleRefinePreviewHostRequest();
		planSpy.mockClear();

		internals._pendingRequestedRefine = { planId: "refine_ser" };
		internals._maybeStartSerializedBackgroundPlan();

		expect(planSpy).not.toHaveBeenCalled();
		await expect(internals._serializedPlanInFlight).resolves.toMatchObject({
			status: "plan",
			plan,
		});
	});

	it("clears the refine abort controller after a pinned serialized kick resolves", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_ser_abort"));
		await harness.session.handleRefinePreviewHostRequest();

		internals._pendingRequestedRefine = { planId: "refine_ser_abort" };
		internals._maybeStartSerializedBackgroundPlan();

		await internals._serializedPlanInFlight;
		expect(internals._refineAbortController).toBeUndefined();
	});

	it("serialized background kick invalidates a missing pinned plan", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		internals._pendingRequestedRefine = { planId: "refine_gone" };
		internals._maybeStartSerializedBackgroundPlan();

		await expect(internals._serializedPlanInFlight).resolves.toMatchObject({ status: "invalidated" });
	});

	it("clears previewed plans when compaction schedules auto-refine", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_compact"));
		await harness.session.handleRefinePreviewHostRequest();
		expect(internals._previewedPlans.size).toBe(1);

		internals._scheduleAutoRefineAfterCompaction(true);
		expect(internals._previewedPlans.size).toBe(0);
	});

	it("clears previewed plans on dispose", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		vi.spyOn(internals, "_planRefine").mockResolvedValue(fakePlan("refine_dispose"));
		await harness.session.handleRefinePreviewHostRequest();

		harness.session.dispose();
		expect(internals._previewedPlans.size).toBe(0);
	});

	it("applying a refinement clears the preview cache", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await harness.session.prompt("one");

		const internals = harness.session as unknown as SessionInternals;
		const emptyPlan = {
			id: "refine_empty",
			proposal: { summary: "s", rationale: "r", expectedOutcome: "o", edits: [] },
		};
		vi.spyOn(internals, "_planRefine").mockResolvedValue(emptyPlan);
		await harness.session.handleRefinePreviewHostRequest();
		expect(internals._previewedPlans.size).toBe(1);

		await internals.refine({ planId: "refine_empty" });
		expect(internals._previewedPlans.size).toBe(0);
	});
});
