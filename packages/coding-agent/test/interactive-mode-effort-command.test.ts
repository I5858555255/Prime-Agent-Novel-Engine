import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type EffortCommandContext = {
	connectionState?: {
		thinkingLevel: ThinkingLevel;
		availableThinkingLevels: ThinkingLevel[];
	};
	agentConnection: { setThinkingLevel: (level: ThinkingLevel) => Promise<void> };
	footer: { invalidate: () => void };
	ui: { requestRender: () => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	updateEditorBorderColor: () => void;
	showFullPaneOverlay: (component: Component, maxContentWidth?: number) => OverlayHandle;
};

type InteractiveModePrototype = {
	showThinkingSelector(this: EffortCommandContext): void;
	applyThinkingLevel(this: EffortCommandContext, level: ThinkingLevel): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function makeContext(overrides: Partial<EffortCommandContext> = {}): EffortCommandContext {
	return {
		connectionState: {
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
		},
		agentConnection: { setThinkingLevel: vi.fn(async () => {}) },
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		patchConnectionState: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showFullPaneOverlay: vi.fn(() => ({ hide: vi.fn() }) as unknown as OverlayHandle),
		...overrides,
	};
}

describe("InteractiveMode /effort", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("opens a thinking selector preselecting the current level", () => {
		const context = makeContext();

		interactiveModePrototype.showThinkingSelector.call(context);

		expect(context.showFullPaneOverlay).toHaveBeenCalledTimes(1);
		const [component] = (context.showFullPaneOverlay as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(component).toBeInstanceOf(ThinkingSelectorComponent);
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("does not open the selector when the model does not support thinking", () => {
		const context = makeContext({
			connectionState: { thinkingLevel: "off", availableThinkingLevels: ["off"] },
		});

		interactiveModePrototype.showThinkingSelector.call(context);

		expect(context.showFullPaneOverlay).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
	});

	it("applies a selected level through the connection and reports it", async () => {
		const setThinkingLevel = vi.fn(async () => {});
		const context = makeContext({ agentConnection: { setThinkingLevel } });

		interactiveModePrototype.applyThinkingLevel.call(context, "high");
		await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Thinking level: high"));

		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(context.patchConnectionState).toHaveBeenCalledWith({ thinkingLevel: "high" });
		expect(context.footer.invalidate).toHaveBeenCalledWith();
		expect(context.updateEditorBorderColor).toHaveBeenCalledWith();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("surfaces an error when applying a level fails", async () => {
		const setThinkingLevel = vi.fn(async () => {
			throw new Error("nope");
		});
		const context = makeContext({ agentConnection: { setThinkingLevel } });

		interactiveModePrototype.applyThinkingLevel.call(context, "high");
		await vi.waitFor(() => expect(context.showError).toHaveBeenCalledWith("nope"));

		expect(context.patchConnectionState).not.toHaveBeenCalled();
	});
});
