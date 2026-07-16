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
		getText: ({ getKeybinding }) => {
			const key = getKeybinding("app.subagents.focus");
			return key
				? `Ask Prime Agent to delegate independent work to subagents, then press ${key} to inspect them.`
				: "Ask Prime Agent to delegate independent work to subagents.";
		},
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
