import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.js";

type SessionContinuationInternals = {
	_schedulePostCompactionContinue(): void;
	_cancelPostCompactionContinue(): void;
	_postCompactionContinuationScheduled: boolean;
};

describe("issue #674 headless completion must not race the post-compaction continuation", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(() => {
		harness.cleanup();
	});

	it("waitForIdle waits for a scheduled continuation instead of resolving into teardown", async () => {
		const internals = harness.session as unknown as SessionContinuationInternals;
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue(undefined as never);

		internals._schedulePostCompactionContinue();
		expect(internals._postCompactionContinuationScheduled).toBe(true);

		await harness.session.waitForIdle();

		// The 100ms continuation timer is pending session work: completion must
		// observe it, not resolve while it is still scheduled (which is how
		// print mode tore the session down mid-run).
		expect(internals._postCompactionContinuationScheduled).toBe(false);
		expect(continueSpy).toHaveBeenCalled();
	});

	it("waitForIdle resolves when a scheduled continuation is cancelled", async () => {
		const internals = harness.session as unknown as SessionContinuationInternals;
		internals._schedulePostCompactionContinue();

		const idle = harness.session.waitForIdle();
		internals._cancelPostCompactionContinue();

		await expect(
			Promise.race([idle.then(() => "idle"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000))]),
		).resolves.toBe("idle");
	});
});
