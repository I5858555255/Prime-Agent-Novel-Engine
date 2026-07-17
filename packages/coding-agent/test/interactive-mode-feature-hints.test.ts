import { type Component, Container, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_HINTS, FeatureHintDeck } from "../src/modes/interactive/feature-hints.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class FakeLoader implements Component {
	readonly stop = vi.fn();

	invalidate(): void {}

	render(width: number): string[] {
		return ["loader".padEnd(width)];
	}
}

function callPrivate(mode: object, name: string): void {
	Reflect.get(InteractiveMode.prototype, name).call(mode);
}

function createMode() {
	const statusContainer = new Container();
	const loader = new FakeLoader();
	statusContainer.addChild(loader);
	const hint = { id: "test", text: "This is a deliberately long feature hint for narrow terminals." };
	const featureHintDeck = { next: vi.fn(() => hint) };
	const requestRender = vi.fn();
	const mode = {
		statusContainer,
		loadingAnimation: loader,
		workingVisible: true,
		connectionState: { isStreaming: true },
		workingTimer: undefined,
		workingStartedAt: 0,
		featureHintDeck,
		currentFeatureHint: undefined,
		featureHintEligibleAt: 0,
		featureHintTimer: undefined,
		featureHintComponent: undefined,
		options: { returnToAgentsView: true },
		ui: { requestRender },
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return { mode, statusContainer, loader, featureHintDeck, requestRender };
}

describe("feature hint deck", () => {
	it("shows every available hint before repeating and avoids a boundary repeat", () => {
		const deck = new FeatureHintDeck(() => 0);
		const context = { getKeybinding: (action: string) => `Custom ${action}`, isResidentSession: true };
		const firstCycle = FEATURE_HINTS.map(() => deck.next(context));

		expect(firstCycle.every((hint) => hint !== undefined)).toBe(true);
		expect(new Set(firstCycle.map((hint) => hint?.id)).size).toBe(FEATURE_HINTS.length);
		expect(deck.next(context)?.id).not.toBe(firstCycle.at(-1)?.id);
	});

	it("uses configured shortcuts in keybinding-based hints", () => {
		const deck = new FeatureHintDeck(() => 0);
		const context = {
			getKeybinding: (action: string) => {
				if (action === "app.prompt.stash") return "Meta+S";
				if (action === "app.message.followUp") return "Meta+Enter";
				return "Meta+Left";
			},
			isResidentSession: true,
		};
		const hints = FEATURE_HINTS.map(() => deck.next(context));

		expect(hints.find((hint) => hint?.id === "prompt-stash")?.text).toContain("Meta+S");
		expect(hints.find((hint) => hint?.id === "follow-up")?.text).toContain("Meta+Enter");
		expect(hints.find((hint) => hint?.id === "agents-view")?.text).toContain("Meta+Left");
	});

	it("covers Prime Agent workflows with capability-focused copy", () => {
		const deck = new FeatureHintDeck(() => 0);
		const hints = FEATURE_HINTS.map(() => deck.next({ getKeybinding: () => "Meta+A", isResidentSession: true }));
		const textById = new Map(hints.map((hint) => [hint?.id, hint?.text]));

		expect(textById.get("subagents")).toBe("Prime Agent can delegate tasks to subagents and run them in parallel.");
		expect(textById.get("agents-view")).toContain("Agents View");
		expect(textById.get("session-rewind")).toContain("/tree");
		expect(textById.get("steering")).toContain("steer");
		expect(textById.get("agent-messaging")).toContain("message each other");
		expect(textById.get("goal")).toContain("/goal");
		expect(textById.get("refine")).toContain("/refine");
		expect(textById.get("persistent-ipython")).toContain("IPython");
		expect(textById.get("context-usage")).toContain("/context");
		expect(textById.get("session-fork")).toContain("/fork");
		expect(textById.get("compaction")).toContain("/compact");
		expect(textById.get("auto-compaction")).toContain("automatically compacts");
		expect(textById.get("auto-refine")).toContain("self-improvement");
		expect(textById.get("background-running")).toContain("close the terminal");
	});

	it("keeps every hint concise", () => {
		const deck = new FeatureHintDeck(() => 0);
		const hints = FEATURE_HINTS.map(() => deck.next({ getKeybinding: () => "Ctrl+Key", isResidentSession: true }));

		expect(hints.every((hint) => hint !== undefined && hint.text.length <= 80)).toBe(true);
	});

	it("hides resident-only hints in ephemeral sessions", () => {
		const context = { getKeybinding: () => "Left", isResidentSession: false };
		const textById = new Map(FEATURE_HINTS.map((hint) => [hint.id, hint.getText(context)]));

		expect(textById.get("agents-view")).toBeUndefined();
		expect(textById.get("background-running")).toBeUndefined();
	});
});

describe("InteractiveMode feature hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("adds one truncated hint after a sustained agent run", () => {
		const { mode, statusContainer, featureHintDeck, requestRender } = createMode();

		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(4_999);
		expect(statusContainer.children).toHaveLength(1);

		vi.advanceTimersByTime(1);
		expect(statusContainer.children).toHaveLength(2);
		const lines = statusContainer.children[1]?.render(24) ?? [];
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toContain("Hint:");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(24);
		expect(featureHintDeck.next).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending hint when the loader stops", () => {
		const { mode, statusContainer, requestRender } = createMode();

		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(2_000);
		callPrivate(mode, "stopWorkingLoader");
		vi.advanceTimersByTime(5_000);

		expect(statusContainer.children).toHaveLength(0);
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("retains the hint and remaining delay when the loader is recreated", () => {
		const { mode, statusContainer, featureHintDeck } = createMode();

		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(3_000);
		callPrivate(mode, "stopWorkingLoader");

		const replacement = new FakeLoader();
		Reflect.set(mode, "loadingAnimation", replacement);
		statusContainer.addChild(replacement);
		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(1_999);
		expect(statusContainer.children).toHaveLength(1);

		vi.advanceTimersByTime(1);
		expect(statusContainer.children).toHaveLength(2);
		expect(featureHintDeck.next).toHaveBeenCalledTimes(1);

		callPrivate(mode, "endFeatureHintRun");
		expect(statusContainer.children).toHaveLength(1);
		expect(Reflect.get(mode, "currentFeatureHint")).toBeUndefined();
	});

	it("keeps the current hint for retries and clears it for new runs", () => {
		const { mode } = createMode();
		Reflect.set(mode, "currentFeatureHint", "Existing hint");
		Reflect.set(mode, "featureHintEligibleAt", 5_000);
		Reflect.set(mode, "connectionState", { isStreaming: true, retryAttempt: 1 });

		callPrivate(mode, "prepareFeatureHintRun");
		expect(Reflect.get(mode, "currentFeatureHint")).toBe("Existing hint");

		Reflect.set(mode, "connectionState", { isStreaming: true, retryAttempt: 0 });
		callPrivate(mode, "prepareFeatureHintRun");
		expect(Reflect.get(mode, "currentFeatureHint")).toBeUndefined();
	});
});
