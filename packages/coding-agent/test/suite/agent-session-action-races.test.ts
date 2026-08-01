import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionStore, SessionAction } from "../../src/core/session-action-store.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

type ActionKind = "turn" | "command";

interface CommitFenceInternals {
	_actionStore: ActionStore<SessionAction>;
	_acquireSessionActionCommitFence(signal?: AbortSignal): Promise<{ release(): void }>;
}

function deliveredCount(harness: Harness, kind: ActionKind, text: string): number {
	if (kind === "turn") return getUserTexts(harness).filter((candidate) => candidate === text).length;
	return harness.session.messages.filter((message) => getMessageText(message) === text).length;
}

describe("AgentSession action commit-fence races", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		...["turn", "command"].flatMap((kind) =>
			(["pause", "clear", "restart", "dispose"] as const).map((interruption) => ({
				kind: kind as ActionKind,
				interruption,
			})),
		),
	])("settles one $kind exactly once when $interruption wins the commit fence", async ({ kind, interruption }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		if (kind === "turn") harness.setResponses([fauxAssistantMessage("done")]);
		const text = kind === "turn" ? "commit-fence turn" : "/autonomous status";
		const reached = createDeferred();
		const releaseFence = createDeferred();
		const internals = harness.session as unknown as CommitFenceInternals;
		const acquireFence = internals._acquireSessionActionCommitFence.bind(internals);
		internals._acquireSessionActionCommitFence = async () => {
			if (internals._actionStore.unfinishedActions().length === 0) return acquireFence();
			reached.resolve();
			await releaseFence.promise;
			return acquireFence();
		};

		let completion: Promise<void>;
		if (kind === "turn") {
			expect(await harness.session.followUp(text, undefined, { resumeIfIdle: true })).toBe(true);
			const action = internals._actionStore.unfinishedActions()[0];
			if (!action) throw new Error("Expected an owned turn action");
			completion = internals._actionStore.ticketFor(action).ticket.completed;
		} else {
			completion = harness.session.promptAndWait(text);
		}
		let settlementCount = 0;
		const outcome = completion.then(
			() => {
				settlementCount++;
				return "resolved" as const;
			},
			() => {
				settlementCount++;
				return "rejected" as const;
			},
		);
		await reached.promise;

		let pause: { release(): void } | undefined;
		if (interruption === "pause") pause = harness.session.acquireQueuedWorkPause();
		else if (interruption === "clear") {
			expect(harness.session.clearQueue().followUp).toEqual([text]);
		} else if (interruption === "restart") harness.session.abortForUpdateRestart();
		else harness.session.dispose();
		releaseFence.resolve();

		if (interruption === "pause" || interruption === "restart") {
			await harness.session.waitForSessionInputCheckpoint();
			expect(deliveredCount(harness, kind, text)).toBe(0);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(1);
			if (interruption === "pause") pause?.release();
			else harness.session.resumeQueuedWork();
			expect(await outcome).toBe("resolved");
			await harness.session.waitForIdle();
			expect(deliveredCount(harness, kind, text)).toBe(1);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
		} else {
			expect(await outcome).toBe("rejected");
			expect(deliveredCount(harness, kind, text)).toBe(0);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
		}
		await Promise.resolve();
		expect(settlementCount).toBe(1);
	});

	it("aborts a prompt waiting for the commit fence without leaking the fence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as CommitFenceInternals;
		const heldFence = await internals._acquireSessionActionCommitFence();
		const controller = new AbortController();
		const prompt = harness.session.prompt("blocked prompt", { signal: controller.signal });
		let promptSettled = false;
		let promptError: unknown;
		void prompt.then(
			() => {
				promptSettled = true;
			},
			(error: unknown) => {
				promptSettled = true;
				promptError = error;
			},
		);

		controller.abort();
		await vi.waitFor(() => {
			expect(promptSettled).toBe(true);
			expect(promptError).toMatchObject({
				name: "PromptAdmissionCancelledError",
				message: "Prompt admission was cancelled.",
			});
		});

		const nextFencePromise = internals._acquireSessionActionCommitFence();
		heldFence.release();
		const nextFence = await nextFencePromise;
		nextFence.release();
	});

	it("does not restart a session command cancelled while waiting for the commit fence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as CommitFenceInternals;
		const pause = harness.session.acquireQueuedWorkPause();
		const text = "/autonomous status";
		const completion = harness.session.promptAndWait(text);
		await vi.waitFor(() => expect(internals._actionStore.unfinishedActions()).toHaveLength(1));
		const heldFence = await internals._acquireSessionActionCommitFence();

		pause.release();
		await vi.waitFor(() => expect(internals._actionStore.unfinishedActions()[0]?.lifecycle.state).toBe("selected"));
		const rejection = expect(completion).rejects.toThrow("cleared before delivery");
		expect(harness.session.clearQueue().followUp).toEqual([text]);
		heldFence.release();

		await rejection;
		await harness.session.waitForSessionInputIdle();
		expect(internals._actionStore.unfinishedActions()).toEqual([]);
	});
});
