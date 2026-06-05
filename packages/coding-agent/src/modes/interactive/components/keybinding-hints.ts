/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export interface KeyTextOptions {
	primaryOnly?: boolean;
}

function formatKey(key: KeyId | string): string {
	return key === "escape" ? "esc" : key;
}

function formatKeys(keys: KeyId[], options: KeyTextOptions = {}): string {
	const displayKeys = (options.primaryOnly ? keys.slice(0, 1) : keys).map((key) => formatKey(key));
	if (displayKeys.length === 0) return "";
	if (displayKeys.length === 1) return displayKeys[0]!;
	return displayKeys.join("/");
}

export function keyText(keybinding: Keybinding, options: KeyTextOptions = {}): string {
	return formatKeys(getKeybindings().getKeys(keybinding), options);
}

export function keyHint(keybinding: Keybinding, description: string, options: KeyTextOptions = {}): string {
	return theme.fg("dim", keyText(keybinding, options)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKey(key)) + theme.fg("muted", ` ${description}`);
}
