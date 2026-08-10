import { type Component, Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import type { HarnessEntrySummary } from "../../../core/refinement/index.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
import { MenuList, MenuPanel, MenuRow } from "./menu-panel.js";

const MAX_VISIBLE_ENTRIES = 10;

export interface HarnessSelectorCallbacks {
	onToggle: (entry: HarnessEntrySummary, enabled: boolean) => Promise<HarnessEntrySummary>;
	onCancel: () => void;
	onRender: () => void;
}

class HarnessEntryList implements Component {
	private entries: HarnessEntrySummary[];
	private selectedIndex = 0;
	private pending = false;
	private error: string | undefined;

	constructor(
		entries: readonly HarnessEntrySummary[],
		private readonly callbacks: HarnessSelectorCallbacks,
	) {
		this.entries = entries.map((entry) => ({ ...entry }));
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.entries.length === 0) {
			return [theme.fg("muted", "  No continual harness entries yet.")];
		}

		const list = new MenuList();
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_ENTRIES / 2), this.entries.length - MAX_VISIBLE_ENTRIES),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_ENTRIES, this.entries.length);
		for (let index = startIndex; index < endIndex; index++) {
			const entry = this.entries[index];
			if (!entry) continue;
			const state = entry.enabled ? "enabled" : "disabled";
			list.addChild(
				new MenuRow({
					primary: `${entry.scope}:${entry.kind}:${entry.id}`,
					secondary: entry.title,
					meta: state,
					selected: index === this.selectedIndex,
				}),
			);
		}
		if (startIndex > 0 || endIndex < this.entries.length) {
			list.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.entries.length})`), 0, 0));
		}
		if (this.error) {
			list.addChild(new Spacer(1));
			list.addChild(new Text(theme.fg("error", this.error), 2, 0));
		}
		return list.render(width);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.callbacks.onCancel();
			return;
		}
		if (this.pending || this.entries.length === 0) return;
		if (keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.entries.length - 1 : this.selectedIndex - 1;
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.entries.length - 1 ? 0 : this.selectedIndex + 1;
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			void this.toggleSelectedEntry();
		}
	}

	private async toggleSelectedEntry(): Promise<void> {
		const entry = this.entries[this.selectedIndex];
		if (!entry) return;
		this.pending = true;
		this.error = undefined;
		this.callbacks.onRender();
		try {
			const updated = await this.callbacks.onToggle(entry, !entry.enabled);
			this.entries[this.selectedIndex] = { ...updated };
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.pending = false;
			this.callbacks.onRender();
		}
	}
}

export class HarnessSelectorComponent extends Container {
	private readonly list: HarnessEntryList;

	constructor(entries: readonly HarnessEntrySummary[], callbacks: HarnessSelectorCallbacks) {
		super();
		const panel = new MenuPanel({
			title: "Continual Harness",
			subtitle: "Enable or disable entries without deleting them.",
		});
		this.addChild(panel);

		this.list = new HarnessEntryList(entries, callbacks);
		panel.addChild(this.list);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "toggle") +
					"  " +
					keyHint("tui.select.cancel", "close"),
				1,
				0,
			),
		);
	}

	getList(): HarnessEntryList {
		return this.list;
	}
}
