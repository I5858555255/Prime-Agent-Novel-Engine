/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.js";
import { runExternalEditor } from "../external-editor.js";
import { getEditorTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private onErrorCallback: (error: unknown) => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
		onError?: (error: unknown) => void,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.onErrorCallback = onError ?? (() => undefined);

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// Create editor
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// Add hint
		const hasExternalEditor = !!(process.env.VISUAL || process.env.EDITOR);
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			(hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// External editor (app keybinding)
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			void this.openExternalEditor().catch((error) => this.onErrorCallback(error));
			return;
		}

		// Forward to editor
		this.editor.handleInput(keyData);
	}

	private async openExternalEditor(): Promise<void> {
		const command = process.env.VISUAL || process.env.EDITOR;
		if (!command) {
			return;
		}

		const content = await runExternalEditor({ tui: this.tui, command, content: this.editor.getText() });
		if (content !== undefined) {
			this.editor.setText(content);
		}
	}
}
