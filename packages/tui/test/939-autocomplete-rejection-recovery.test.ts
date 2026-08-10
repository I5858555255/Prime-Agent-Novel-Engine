import assert from "node:assert";
import { describe, it } from "node:test";
import {
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
} from "../src/autocomplete.js";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function applyCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: { value: string },
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const newLines = [...lines];
	const line = newLines[cursorLine] ?? "";
	newLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
	return {
		lines: newLines,
		cursorLine,
		cursorCol: cursorCol - prefix.length + item.value.length,
	};
}

async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 500;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			assert.fail(message);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

function createEditor(): Editor {
	return new Editor(new TUI(new VirtualTerminal()), defaultEditorTheme);
}

function suggestions(prefix = ""): AutocompleteSuggestions {
	return {
		items: [
			{ value: "alpha", label: "alpha" },
			{ value: "beta", label: "beta" },
		],
		prefix,
	};
}

describe("autocomplete rejection recovery", () => {
	it("continues with the next request after a provider rejects once", async () => {
		const editor = createEditor();
		let calls = 0;
		let abortsAfterFailure = 0;
		const failure = new Error("temporary autocomplete failure");
		const diagnostics: unknown[] = [];
		const provider: AutocompleteProvider = {
			getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
				calls += 1;
				if (calls === 1) {
					options.signal.addEventListener("abort", () => {
						abortsAfterFailure += 1;
					});
					throw failure;
				}
				return suggestions();
			},
			applyCompletion,
		};
		editor.setAutocompleteProvider(provider);
		editor.onAutocompleteError = (error) => {
			diagnostics.push(error);
		};

		editor.handleInput("\t");
		await waitFor(() => calls === 1, "first autocomplete request did not run");
		await settle();
		editor.handleInput("\t");
		await waitFor(() => editor.isShowingAutocomplete(), "autocomplete did not recover after rejection");

		assert.strictEqual(calls, 2);
		assert.deepStrictEqual(diagnostics, [failure]);
		assert.strictEqual(abortsAfterFailure, 0, "the failed request controller should be cleared in finally");
	});

	it("silently advances after an active request is aborted", async () => {
		const editor = createEditor();
		let calls = 0;
		let aborts = 0;
		const diagnostics: unknown[] = [];
		editor.onAutocompleteError = (error) => {
			diagnostics.push(error);
		};
		editor.setAutocompleteProvider({
			getSuggestions: async (_lines, _cursorLine, _cursorCol, options) => {
				calls += 1;
				if (calls > 1) return suggestions();
				return await new Promise<AutocompleteSuggestions>((_resolve, reject) => {
					options.signal.addEventListener(
						"abort",
						() => {
							aborts += 1;
							reject(new DOMException("Autocomplete cancelled", "AbortError"));
						},
						{ once: true },
					);
				});
			},
			applyCompletion,
		});

		editor.handleInput("\t");
		await waitFor(() => calls === 1, "active autocomplete request did not start");
		editor.handleInput("\t");
		await waitFor(() => editor.isShowingAutocomplete(), "queue did not advance after abort");

		assert.strictEqual(aborts, 1);
		assert.strictEqual(calls, 2);
		assert.deepStrictEqual(diagnostics, []);
	});

	it("ignores a stale result and accepts a later request", async () => {
		const editor = createEditor();
		let calls = 0;
		let resolveFirst: ((result: AutocompleteSuggestions) => void) | undefined;
		editor.setAutocompleteProvider({
			getSuggestions: async () => {
				calls += 1;
				if (calls > 1) return suggestions("x");
				return await new Promise<AutocompleteSuggestions>((resolve) => {
					resolveFirst = resolve;
				});
			},
			applyCompletion,
		});

		editor.handleInput("\t");
		await waitFor(() => resolveFirst !== undefined, "stale autocomplete request did not start");
		editor.handleInput("x");
		resolveFirst?.(suggestions());
		await settle();

		assert.strictEqual(editor.getText(), "x");
		assert.strictEqual(editor.isShowingAutocomplete(), false);

		editor.handleInput("\t");
		await waitFor(() => editor.isShowingAutocomplete(), "later autocomplete request did not run");
		assert.strictEqual(calls, 2);
	});

	it("retains symbol autocomplete debouncing", async () => {
		const editor = createEditor();
		let calls = 0;
		editor.setAutocompleteProvider({
			getSuggestions: async (lines, _cursorLine, cursorCol) => {
				calls += 1;
				return suggestions((lines[0] ?? "").slice(0, cursorCol));
			},
			applyCompletion,
		});

		for (const character of "@main") {
			editor.handleInput(character);
		}

		assert.strictEqual(calls, 0);
		await waitFor(() => editor.isShowingAutocomplete(), "debounced autocomplete request did not run");
		assert.strictEqual(calls, 1);
	});

	it("contains extension argument-completion failures", async () => {
		const editor = createEditor();
		let calls = 0;
		const failure = new Error("extension completion failed");
		const diagnostics: unknown[] = [];
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "load",
					getArgumentCompletions: async (prefix) => {
						calls += 1;
						if (calls === 1) throw failure;
						return [{ value: `${prefix}-result`, label: `${prefix}-result` }];
					},
				},
			],
			process.cwd(),
		);
		editor.setAutocompleteProvider(provider);
		editor.onAutocompleteError = (error) => {
			diagnostics.push(error);
		};
		editor.setText("/load ");

		editor.handleInput("a");
		await waitFor(() => calls === 1, "extension autocomplete request did not run");
		await settle();
		editor.handleInput("b");
		await waitFor(() => editor.isShowingAutocomplete(), "extension autocomplete did not recover");

		assert.strictEqual(editor.getText(), "/load ab");
		assert.strictEqual(calls, 2);
		assert.deepStrictEqual(diagnostics, [failure]);
	});

	it("recovers after repeated failures even when diagnostics reject", async () => {
		const editor = createEditor();
		let calls = 0;
		let diagnosticCalls = 0;
		editor.onAutocompleteError = async () => {
			diagnosticCalls += 1;
			throw new Error("diagnostic sink unavailable");
		};
		editor.setAutocompleteProvider({
			getSuggestions: async () => {
				calls += 1;
				if (calls <= 2) throw new Error(`failure ${calls}`);
				return suggestions("ab");
			},
			applyCompletion,
		});

		editor.handleInput("\t");
		await waitFor(() => calls === 1, "first failing request did not run");
		await settle();
		editor.handleInput("a");
		editor.handleInput("\t");
		await waitFor(() => calls === 2, "second failing request did not run");
		await settle();
		editor.handleInput("b");
		editor.handleInput("\t");
		await waitFor(() => editor.isShowingAutocomplete(), "request after repeated failures did not recover");

		assert.strictEqual(editor.getText(), "ab");
		assert.strictEqual(calls, 3);
		assert.strictEqual(diagnosticCalls, 2);
	});
});
