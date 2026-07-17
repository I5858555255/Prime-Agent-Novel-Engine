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
		getText: () => "Use /btw <question> to ask a side question without changing the main session.",
	},
	{
		id: "prompt-stash",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.prompt.stash");
			return key ? `Press ${key} to stash a draft, run another prompt, and restore it afterward.` : undefined;
		},
	},
	{
		id: "follow-up",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.message.followUp");
			return key ? `Press ${key} to queue a follow-up after the current work finishes.` : undefined;
		},
	},
	{
		id: "heartbeat",
		getText: () => "Use /heartbeat every 10m <instruction> to schedule recurring agent work.",
	},
	{
		id: "subagents",
		getText: () => "Prime Agent can delegate independent work to subagents so tasks can run in parallel.",
	},
	{
		id: "agents-view",
		getText: () =>
			"The Agents View brings active, waiting, and completed agents together for monitoring and management.",
	},
	{
		id: "session-rewind",
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.input.clear");
			return key
				? `Press ${key} twice from an empty prompt to open the tree view and rewind the session.`
				: undefined;
		},
	},
	{
		id: "steering",
		getText: () =>
			"Messages sent while Prime Agent is working steer the current task after its active tool calls finish.",
	},
	{
		id: "agent-messaging",
		getText: () =>
			"Agents can message one another to share context, coordinate dependencies, and orchestrate parallel work.",
	},
	{
		id: "goal",
		getText: () =>
			"Use /goal <objective> to let Prime Agent keep working across turns until a longer-running outcome is complete.",
	},
	{
		id: "refine",
		getText: () =>
			"Use /refine after a reusable discovery to update Prime Agent's local skills, memory, prompts, or subagents.",
	},
	{
		id: "persistent-ipython",
		getText: () => "Prime Agent's IPython kernel preserves variables and helpers across turns and compaction.",
	},
	{
		id: "context-usage",
		getText: () => "Use /context to inspect token, cost, and context usage across the agent and its subagents.",
	},
	{
		id: "session-fork",
		getText: () => "Use /fork to branch from an earlier prompt without losing the current session.",
	},
	{
		id: "compaction",
		getText: () => "Use /compact <instructions> to summarize older context around the details you want to preserve.",
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
