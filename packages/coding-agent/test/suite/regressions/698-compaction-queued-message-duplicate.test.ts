import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentConnectionSessionEvent } from "../../../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";

type DedupeContext = {
	isInitialized: boolean;
	rebuildRenderedLiveMessageKeys: Set<string>;
	contextUsageTokenBaseline: number;
	agentRunFileChanges: Set<string>;
	footer: { invalidate: () => void };
	activityTracker: { handleEvent: (event: AgentConnectionSessionEvent) => void };
	ui: { requestRender: () => void };
	updateConnectionStateFromEvent: (event: AgentConnectionSessionEvent) => void;
	prepareFeatureHintRun: (message: AgentMessage) => void;
	setSessionHasMessages: (value: boolean) => void;
	clearShortcutGuide: () => void;
	renderRecap: () => void;
	updateWorkingLoaderMessage: () => void;
	addMessageToChat: (message: AgentMessage) => void;
	consumeRebuildRenderedMessage: (message: AgentMessage) => boolean;
};

type DedupePrototype = {
	handleEvent(this: DedupeContext, event: AgentConnectionSessionEvent): Promise<void>;
	recordRebuildRenderedMessages(this: DedupeContext, messages: readonly AgentMessage[]): void;
	consumeRebuildRenderedMessage(this: DedupeContext, message: AgentMessage): boolean;
};

const prototype = InteractiveMode.prototype as unknown as DedupePrototype;

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp } as AgentMessage;
}

function createContext(rendered: string[]): DedupeContext {
	return {
		consumeRebuildRenderedMessage(this: DedupeContext, message: AgentMessage): boolean {
			return prototype.consumeRebuildRenderedMessage.call(this, message);
		},
		isInitialized: true,
		rebuildRenderedLiveMessageKeys: new Set<string>(),
		contextUsageTokenBaseline: 0,
		agentRunFileChanges: new Set<string>(),
		footer: { invalidate: () => {} },
		activityTracker: { handleEvent: () => {} },
		ui: { requestRender: () => {} },
		updateConnectionStateFromEvent: () => {},
		prepareFeatureHintRun: () => {},
		setSessionHasMessages: () => {},
		clearShortcutGuide: () => {},
		renderRecap: () => {},
		updateWorkingLoaderMessage: () => {},
		addMessageToChat: (message) => {
			if (message.role === "user" && typeof message.content === "string") {
				rendered.push(message.content);
			}
		},
	};
}

function messageStart(message: AgentMessage): AgentConnectionSessionEvent {
	return { type: "message_start", message } as AgentConnectionSessionEvent;
}

describe("issue #698 queued message is not rendered twice after /compact rebuild", () => {
	it("skips the in-flight message_start for a message the rebuild already rendered", async () => {
		const rendered: string[] = [];
		const ctx = createContext(rendered);
		const queued = userMessage("queued during compaction", 1000);

		// compaction_end rebuild: snapshot already contains the consumed queued message.
		prototype.recordRebuildRenderedMessages.call(ctx, [queued]);
		// The in-flight message_start for the same message arrives after the rebuild.
		await prototype.handleEvent.call(ctx, messageStart(queued));

		expect(rendered).toEqual([]);
	});

	it("still renders fresh messages sent after the rebuild", async () => {
		const rendered: string[] = [];
		const ctx = createContext(rendered);
		const queued = userMessage("queued during compaction", 1000);
		const fresh = userMessage("next question", 2000);

		prototype.recordRebuildRenderedMessages.call(ctx, [queued]);
		await prototype.handleEvent.call(ctx, messageStart(queued));
		await prototype.handleEvent.call(ctx, messageStart(fresh));

		expect(rendered).toEqual(["next question"]);
	});

	it("consumes each rebuild key once, so identical later events fail open to rendering", async () => {
		const rendered: string[] = [];
		const ctx = createContext(rendered);
		const queued = userMessage("queued during compaction", 1000);

		prototype.recordRebuildRenderedMessages.call(ctx, [queued]);
		await prototype.handleEvent.call(ctx, messageStart(queued));
		await prototype.handleEvent.call(ctx, messageStart(queued));

		expect(rendered).toEqual(["queued during compaction"]);
	});

	it("only records roles that live events render, and a new rebuild resets the keys", () => {
		const ctx = createContext([]);
		const assistant = { role: "assistant", content: [], timestamp: 1 } as unknown as AgentMessage;
		prototype.recordRebuildRenderedMessages.call(ctx, [assistant, userMessage("a", 1)]);
		expect(ctx.rebuildRenderedLiveMessageKeys.size).toBe(1);
		prototype.recordRebuildRenderedMessages.call(ctx, [userMessage("b", 2)]);
		expect(ctx.rebuildRenderedLiveMessageKeys.size).toBe(1);
	});
});
