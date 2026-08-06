import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.js";

type ParentInternals = {
	_activeRlmChildRuns: Map<string, unknown>;
};

type ChildInternals = {
	_parentReplyCount: number;
	_postCompactionContinuationScheduled: boolean;
	_runScheduledPostCompactionContinue(): Promise<void>;
	_schedulePostCompactionContinue(): void;
};

function terminalNotices(harness: Harness): Array<Extract<AgentMessage, { role: "custom" }>> {
	return harness.session.messages.filter(
		(message): message is Extract<AgentMessage, { role: "custom" }> =>
			message.role === "custom" && message.customType === "rlm_child_terminal_notice",
	);
}

describe("RLM child compaction terminal notices", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it("preserves cancellation while waiting for a post-compaction continuation", async () => {
		let markContinuationStarted: () => void = () => {};
		const continuationStarted = new Promise<void>((resolve) => {
			markContinuationStarted = resolve;
		});
		child = await createHarness({ rlmDepth: 1, rlmMaxDepth: 1 });
		vi.spyOn(child.session, "abort").mockImplementation(async () => new Promise(() => {}));
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		const internals = child.session as unknown as ChildInternals;
		vi.spyOn(child.session, "promptAndWait").mockImplementation(async () => {
			internals._schedulePostCompactionContinue();
		});
		vi.spyOn(internals, "_runScheduledPostCompactionContinue").mockImplementation(async () => {
			markContinuationStarted();
			await new Promise(() => {});
		});

		const spawned = await parent.session.runRlmChild("wait after compaction", { name: "cancelled-worker" });
		await continuationStarted;
		expect(parent.session.cancelRlmChildRun(spawned.rlm_child_id)).toBe(true);

		const parentInternals = parent.session as unknown as ParentInternals;
		expect(parentInternals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(true);
		expect(terminalNotices(parent)).toHaveLength(0);
		await expect
			.poll(() => parentInternals._activeRlmChildRuns.has(spawned.rlm_child_id), { timeout: 2000 })
			.toBe(false);
		expect(terminalNotices(parent)).toHaveLength(1);
		expect(terminalNotices(parent)[0]?.details).toMatchObject({
			kind: "cancelled",
			reason: "Cancelled by user",
		});
	});

	it("waits for a real threshold-compaction continuation to reply", async () => {
		const sentMessages: string[] = [];
		const replyTool: AgentTool = {
			name: "reply-parent",
			label: "Reply to parent",
			description: "Reply after compaction",
			parameters: Type.Object({}),
			execute: async () => {
				const internals = child!.session as unknown as ChildInternals;
				internals._parentReplyCount += 1;
				sentMessages.push("work finished after threshold compaction");
				return { content: [{ type: "text", text: "reply delivered" }], details: {} };
			},
		};
		child = await createHarness({
			rlmDepth: 1,
			rlmMaxDepth: 1,
			tools: [replyTool],
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				maxTurns: 100,
				gates: {
					commands: [`${process.execPath} -e "process.exit(1)"`],
					maxRetries: 1,
				},
			},
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1 } },
			models: [{ id: "faux-compacting-child", contextWindow: 1000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "threshold summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "test" },
						},
					}));
				},
			],
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		for (let index = 0; index < 3; index++) {
			const userMessage = {
				role: "user" as const,
				content: `history ${index} ${"x".repeat(200)}`,
				timestamp: index * 2 + 1,
			};
			const assistantMessage = fauxAssistantMessage(`history response ${index}`, { timestamp: index * 2 + 2 });
			child.sessionManager.appendMessage(userMessage);
			child.sessionManager.appendMessage(assistantMessage);
			child.session.agent.state.messages.push(userMessage, assistantMessage);
		}
		child.setResponses([
			fauxAssistantMessage("initial pass"),
			fauxAssistantMessage(fauxToolCall("reply-parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("finished"),
		]);

		const spawned = await parent.session.runRlmChild("finish across compaction", { name: "threshold-worker" });

		await expect.poll(() => sentMessages, { timeout: 10_000 }).toEqual(["work finished after threshold compaction"]);
		const parentInternals = parent.session as unknown as ParentInternals;
		await expect
			.poll(() => parentInternals._activeRlmChildRuns.has(spawned.rlm_child_id), { timeout: 10_000 })
			.toBe(false);
		expect(child.eventsOfType("compaction_start")).toContainEqual(expect.objectContaining({ reason: "threshold" }));
		expect(terminalNotices(parent)).toHaveLength(0);
	}, 15_000);
});
