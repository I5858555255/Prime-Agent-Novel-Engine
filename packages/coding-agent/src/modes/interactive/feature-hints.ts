import type { AppKeybinding } from "../../core/keybindings.js";

export interface FeatureHintContext {
	getKeybinding(action: AppKeybinding): string | undefined;
}

interface FeatureHintDefinition {
	id: string;
	getText(context: FeatureHintContext): string | undefined;
}

export interface FeatureHint {
	id: string;
	text: string;
}

export const FEATURE_HINTS: readonly FeatureHintDefinition[] = [
	{
		id: "side-question",
		getText: () => "Use /btw <question> for a side question that won't change the main session.",
	},
	{
		id: "prompt-stash",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.prompt.stash");
			return key ? `Press ${key} to stash your draft and restore it later.` : undefined;
		},
	},
	{
		id: "follow-up",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.message.followUp");
			return key ? `Press ${key} to queue a message after the current task.` : undefined;
		},
	},
	{
		id: "heartbeat",
		getText: () => "Use /heartbeat every 10m <instruction> to schedule recurring work.",
	},
	{
		id: "subagents",
		getText: () => "Prime Agent can delegate independent tasks to subagents in parallel.",
	},
	{
		id: "agents-view",
		getText: () => "The Agents View shows your working, waiting, and completed agents.",
	},
	{
		id: "session-rewind",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.input.clear");
			return key ? `Press ${key} twice on an empty prompt to open the tree and rewind.` : undefined;
		},
	},
	{
		id: "steering",
		getText: () => "Messages sent during active work steer the current task.",
	},
	{
		id: "agent-messaging",
		getText: () => "Agents can message each other to share context and coordinate work.",
	},
	{
		id: "goal",
		getText: () => "Use /goal <objective> for work that should continue across turns.",
	},
	{
		id: "refine",
		getText: () => "Use /refine to save useful lessons as skills, memory, prompts, or subagents.",
	},
	{
		id: "persistent-ipython",
		getText: () => "IPython keeps variables and helpers available across turns and compaction.",
	},
	{
		id: "context-usage",
		getText: () => "Use /context to see token, cost, and context usage.",
	},
	{
		id: "session-fork",
		getText: () => "Use /fork to branch from an earlier prompt without losing the current session.",
	},
	{
		id: "compaction",
		getText: () => "Use /compact <instructions> to summarize old context around what matters.",
	},
] as const;

export class FeatureHintDeck {
	private remaining: FeatureHint[] = [];
	private previousId: string | undefined;

	constructor(private readonly random: () => number = Math.random) {}

	next(context: FeatureHintContext): FeatureHint | undefined {
		if (this.remaining.length === 0) {
			this.refill(context);
		}
		const hint = this.remaining.pop();
		if (hint) {
			this.previousId = hint.id;
		}
		return hint;
	}

	private refill(context: FeatureHintContext): void {
		const hints = FEATURE_HINTS.flatMap((hint) => {
			const text = hint.getText(context);
			return text ? [{ id: hint.id, text }] : [];
		});
		for (let index = hints.length - 1; index > 0; index--) {
			const random = Math.min(0.999999999, Math.max(0, this.random()));
			const target = Math.floor(random * (index + 1));
			[hints[index], hints[target]] = [hints[target]!, hints[index]!];
		}
		if (hints.length > 1 && hints[hints.length - 1]?.id === this.previousId) {
			[hints[0], hints[hints.length - 1]] = [hints[hints.length - 1]!, hints[0]!];
		}
		this.remaining = hints;
	}
}
