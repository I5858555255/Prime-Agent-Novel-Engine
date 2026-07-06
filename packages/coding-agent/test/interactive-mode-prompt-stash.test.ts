import { describe, expect, it, type Mock, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type FakeEditor = {
	text: string;
	expandedText: string;
	history: string[];
	getText: () => string;
	getExpandedText: () => string;
	setText: (text: string) => void;
	addToHistory: Mock;
	getHistory: () => readonly string[];
};

type PromptStashHarness = {
	promptStash?: string;
	editor: FakeEditor;
	showStatus: Mock;
};

type PromptStashLiveMarkerHarness = PromptStashHarness & {
	compactionQueuedMessages: Array<{ text: string; mode: "steer" | "followUp" }>;
	connectionQueue: { steering: string[]; followUp: string[] };
};

type SubmitHarness = PromptStashHarness & {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	isAgentCompacting: () => boolean;
	isAgentStreaming: () => boolean;
	flushPendingBashComponents: Mock;
	onInputCallback: Mock;
};

type PromptStashMethods = {
	handlePromptStash: (this: PromptStashHarness) => void;
	restorePromptStashIfEditorEmpty: (this: PromptStashHarness) => boolean;
	liveImageMarkerIds: (this: PromptStashLiveMarkerHarness) => Set<number>;
	setupEditorSubmitHandler: (this: SubmitHarness) => void;
};

const interactiveModeMethods = InteractiveMode.prototype as unknown as PromptStashMethods;

function createEditor(options: { text?: string; expandedText?: string; history?: string[] } = {}): FakeEditor {
	const editor: FakeEditor = {
		text: options.text ?? "",
		expandedText: options.expandedText ?? options.text ?? "",
		history: options.history ?? [],
		getText() {
			return this.text;
		},
		getExpandedText() {
			return this.expandedText;
		},
		setText(nextText: string) {
			this.text = nextText;
			this.expandedText = nextText;
		},
		addToHistory: vi.fn(),
		getHistory() {
			return this.history;
		},
	};
	return editor;
}

function createPromptStashHarness(options: { text?: string; expandedText?: string; stash?: string } = {}) {
	const harness: PromptStashHarness = {
		promptStash: options.stash,
		editor: createEditor({ text: options.text, expandedText: options.expandedText }),
		showStatus: vi.fn(),
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

describe("InteractiveMode prompt stash", () => {
	it("uses Ctrl+S as the default configurable stash keybinding", () => {
		const keybindings = new KeybindingsManager();

		expect(keybindings.getKeys("app.prompt.stash")).toEqual(["ctrl+s"]);
	});

	it("stashes expanded editor text and clears the editor", () => {
		const mode = createPromptStashHarness({
			text: "[paste #1 +12 lines]",
			expandedText: "line one\nline two",
		});

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash).toBe("line one\nline two");
		expect(mode.editor.getText()).toBe("");
		expect(mode.showStatus).toHaveBeenCalledWith("Stashed prompt");
	});

	it("restores a stashed prompt when the editor is empty", () => {
		const mode = createPromptStashHarness({ stash: "half-written draft" });

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
		expect(mode.showStatus).toHaveBeenCalledWith("Restored stashed prompt");
	});

	it("does not overwrite an existing stash", () => {
		const mode = createPromptStashHarness({ text: "second draft", stash: "first draft" });

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash).toBe("first draft");
		expect(mode.editor.getText()).toBe("second draft");
		expect(mode.showStatus).toHaveBeenCalledWith("Prompt stash already has a draft");
	});

	it("restores a stashed prompt after normal message submission clears the editor", async () => {
		const mode: SubmitHarness = {
			...createPromptStashHarness({ stash: "half-written draft" }),
			defaultEditor: {},
			isAgentCompacting: () => false,
			isAgentStreaming: () => false,
			flushPendingBashComponents: vi.fn(),
			onInputCallback: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		interactiveModeMethods.setupEditorSubmitHandler.call(mode);

		await mode.defaultEditor.onSubmit?.("temporary prompt");

		expect(mode.onInputCallback).toHaveBeenCalledWith("temporary prompt");
		expect(mode.editor.addToHistory).toHaveBeenCalledWith("temporary prompt");
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("keeps image markers in a stashed prompt live", () => {
		const mode: PromptStashLiveMarkerHarness = {
			...createPromptStashHarness({ stash: "look at [image #7]" }),
			compactionQueuedMessages: [],
			connectionQueue: { steering: [], followUp: [] },
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		expect(interactiveModeMethods.liveImageMarkerIds.call(mode)).toEqual(new Set([7]));
	});
});
