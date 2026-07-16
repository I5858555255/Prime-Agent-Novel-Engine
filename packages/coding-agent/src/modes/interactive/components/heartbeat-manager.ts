import { type Component, type Focusable, getKeybindings, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import type { AgentHeartbeatManagementAction } from "../../../core/cron-jobs.js";
import type { AgentConnectionHeartbeat } from "../../agent-connection/types.js";
import { theme } from "../theme/theme.js";
import { getMenuListLayout, MenuList, MenuPanel, MenuRow } from "./menu-panel.js";

const PREFERRED_VISIBLE_HEARTBEATS = 8;
const HEARTBEAT_LIST_RESERVED_ROWS = 5;
const HEARTBEAT_SCROLL_INDICATOR_ROWS = 1;

type HeartbeatManagerMode =
	| { type: "list" }
	| { type: "actions"; heartbeatId: string; selectedIndex: number }
	| { type: "confirm-stop"; heartbeatId: string; selectedIndex: number };

export interface HeartbeatManagerOptions {
	getRows: () => number;
	onAction: (heartbeat: AgentConnectionHeartbeat, action: AgentHeartbeatManagementAction) => Promise<void>;
	onClose: () => void;
	requestRender: () => void;
}

export class HeartbeatManagerComponent implements Component, Focusable {
	private heartbeats: AgentConnectionHeartbeat[] = [];
	private selectedIndex = 0;
	private mode: HeartbeatManagerMode = { type: "list" };
	private busy = false;
	private error: string | undefined;
	private _focused = false;

	constructor(
		heartbeats: readonly AgentConnectionHeartbeat[],
		private readonly options: HeartbeatManagerOptions,
	) {
		this.setHeartbeats(heartbeats);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {}

	setHeartbeats(heartbeats: readonly AgentConnectionHeartbeat[]): void {
		const selectedId = this.heartbeats[this.selectedIndex]?.job.id;
		this.heartbeats = [...heartbeats].sort((left, right) => {
			const sessionOrder = this.sessionLabel(left).localeCompare(this.sessionLabel(right));
			if (sessionOrder !== 0) return sessionOrder;
			if (left.job.source !== right.job.source) return left.job.source === "heartbeat" ? -1 : 1;
			return left.job.createdAt.localeCompare(right.job.createdAt);
		});
		const nextIndex = selectedId
			? this.heartbeats.findIndex((heartbeat) => heartbeat.job.id === selectedId)
			: this.selectedIndex;
		this.selectedIndex = Math.max(0, Math.min(nextIndex < 0 ? 0 : nextIndex, this.heartbeats.length - 1));
		if (this.mode.type !== "list" && !this.findHeartbeat(this.mode.heartbeatId)) {
			this.mode = { type: "list" };
		}
		this.options.requestRender();
	}

	handleInput(data: string): void {
		if (this.busy) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			if (this.mode.type === "list") {
				this.options.onClose();
			} else {
				this.mode = { type: "list" };
				this.error = undefined;
				this.options.requestRender();
			}
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			void this.confirmSelection();
		}
	}

	render(width: number): string[] {
		const panel = this.mode.type === "list" ? this.createHeartbeatListPanel() : this.createActionPanel(this.mode);
		return panel.render(width);
	}

	private createHeartbeatListPanel(): MenuPanel {
		const active = this.heartbeats.filter((heartbeat) => heartbeat.job.status === "active").length;
		const paused = this.heartbeats.length - active;
		const countLabel = `${this.heartbeats.length} heartbeat${this.heartbeats.length === 1 ? "" : "s"}${paused ? ` · ${paused} paused` : ""}`;
		const panel = new MenuPanel({
			title: "Heartbeats",
			subtitle: `${countLabel}. Select a heartbeat to manage.`,
		});
		const list = new MenuList({ compact: this.getListLayout().compact });
		this.populateHeartbeatList(list);
		panel.addChild(list);
		if (this.error) {
			panel.addChild(new Spacer(1));
			panel.addChild(new TruncatedText(theme.fg("error", `Error: ${this.error}`), 1, 0));
		}
		return panel;
	}

	private populateHeartbeatList(list: MenuList): void {
		if (this.heartbeats.length === 0) {
			list.addChild(new TruncatedText(theme.fg("muted", "No running or paused heartbeats"), 1, 0));
			return;
		}
		const visibleItems = this.getListLayout().visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(visibleItems / 2), this.heartbeats.length - visibleItems),
		);
		const endIndex = Math.min(startIndex + visibleItems, this.heartbeats.length);

		for (let index = startIndex; index < endIndex; index++) {
			const heartbeat = this.heartbeats[index];
			if (!heartbeat) continue;
			const source = heartbeat.job.source === "heartbeat" ? "User" : "Agent";
			const label = heartbeat.job.label?.trim();
			const delivery = heartbeat.job.deliveryMode === "follow_up" ? "follow-up" : "steer";
			const details = [
				source,
				this.sessionLabel(heartbeat),
				heartbeat.job.schedule.expression,
				delivery,
				heartbeat.job.lastError ? `error: ${this.singleLine(heartbeat.job.lastError)}` : undefined,
			]
				.filter((value) => value !== undefined)
				.join(" · ");
			list.addChild(
				new MenuRow({
					primary: label || this.singleLine(heartbeat.job.prompt) || `${source} heartbeat`,
					secondary: details,
					meta: this.formatStatus(heartbeat),
					selected: index === this.selectedIndex,
				}),
			);
		}

		if (startIndex > 0 || endIndex < this.heartbeats.length) {
			list.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.heartbeats.length})`), 1, 0),
			);
		}
	}

	private createActionPanel(mode: Exclude<HeartbeatManagerMode, { type: "list" }>): MenuPanel {
		const heartbeat = this.findHeartbeat(mode.heartbeatId);
		if (!heartbeat) {
			return new MenuPanel({ title: "Heartbeats", subtitle: "This heartbeat is no longer available." });
		}
		const source = heartbeat.job.source === "heartbeat" ? "User heartbeat" : "Agent heartbeat";
		const name = heartbeat.job.label?.trim() || source;
		const panel = new MenuPanel({
			title: mode.type === "confirm-stop" ? "Stop heartbeat?" : name,
			subtitle:
				mode.type === "confirm-stop"
					? `This removes ${name} and clears its queued deliveries.`
					: this.singleLine(heartbeat.job.prompt),
		});
		if (mode.type !== "confirm-stop") {
			panel.addChild(new TruncatedText(theme.fg("muted", this.formatHeartbeatDetails(heartbeat)), 1, 0));
			panel.addChild(new Spacer(1));
		}
		if (this.error) {
			panel.addChild(new TruncatedText(theme.fg("error", `Error: ${this.error}`), 1, 0));
			panel.addChild(new Spacer(1));
		}
		const list = new MenuList();
		if (mode.type === "confirm-stop") {
			const choices = [
				{ primary: "Stop heartbeat", secondary: "Remove it and clear queued deliveries" },
				{ primary: "Keep heartbeat", secondary: "Return without making changes" },
			];
			for (const [index, choice] of choices.entries()) {
				list.addChild(new MenuRow({ ...choice, selected: index === mode.selectedIndex }));
			}
			panel.addChild(list);
			return panel;
		}
		for (const [index, action] of this.availableActions(heartbeat).entries()) {
			list.addChild(
				new MenuRow({
					primary: action.label,
					secondary: this.actionDescription(action.action),
					selected: index === mode.selectedIndex,
				}),
			);
		}
		panel.addChild(list);
		return panel;
	}

	private moveSelection(delta: number): void {
		if (this.mode.type === "list") {
			if (this.heartbeats.length === 0) return;
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + delta, this.heartbeats.length - 1));
		} else {
			const count =
				this.mode.type === "confirm-stop"
					? 2
					: this.availableActions(this.findHeartbeat(this.mode.heartbeatId)).length;
			this.mode = { ...this.mode, selectedIndex: Math.max(0, Math.min(this.mode.selectedIndex + delta, count - 1)) };
		}
		this.options.requestRender();
	}

	private async confirmSelection(): Promise<void> {
		if (this.mode.type === "list") {
			const heartbeat = this.heartbeats[this.selectedIndex];
			if (heartbeat) {
				this.mode = { type: "actions", heartbeatId: heartbeat.job.id, selectedIndex: 0 };
				this.options.requestRender();
			}
			return;
		}
		const heartbeat = this.findHeartbeat(this.mode.heartbeatId);
		if (!heartbeat) {
			this.mode = { type: "list" };
			this.options.requestRender();
			return;
		}
		if (this.mode.type === "confirm-stop") {
			if (this.mode.selectedIndex === 0) await this.runAction(heartbeat, "stop");
			else this.mode = { type: "list" };
			this.options.requestRender();
			return;
		}
		const selected = this.availableActions(heartbeat)[this.mode.selectedIndex];
		if (!selected || selected.action === "back") {
			this.mode = { type: "list" };
			this.options.requestRender();
			return;
		}
		if (selected.action === "stop") {
			this.mode = { type: "confirm-stop", heartbeatId: heartbeat.job.id, selectedIndex: 1 };
			this.options.requestRender();
			return;
		}
		await this.runAction(heartbeat, selected.action);
	}

	private async runAction(heartbeat: AgentConnectionHeartbeat, action: AgentHeartbeatManagementAction): Promise<void> {
		this.busy = true;
		this.error = undefined;
		this.options.requestRender();
		try {
			await this.options.onAction(heartbeat, action);
			this.mode = { type: "list" };
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			this.options.requestRender();
		}
	}

	private availableActions(heartbeat: AgentConnectionHeartbeat | undefined): Array<{
		label: string;
		action: AgentHeartbeatManagementAction | "back";
	}> {
		if (!heartbeat) return [];
		return [
			heartbeat.job.status === "paused"
				? { label: "Resume heartbeat", action: "resume" }
				: { label: "Pause heartbeat", action: "pause" },
			{ label: "Stop heartbeat", action: "stop" },
			{ label: "Back", action: "back" },
		];
	}

	private findHeartbeat(id: string): AgentConnectionHeartbeat | undefined {
		return this.heartbeats.find((heartbeat) => heartbeat.job.id === id);
	}

	private sessionLabel(heartbeat: AgentConnectionHeartbeat): string {
		return heartbeat.sessionName?.trim() || this.singleLine(heartbeat.firstMessage ?? "") || heartbeat.job.sessionId;
	}

	private getListLayout() {
		return getMenuListLayout({
			getRows: this.options.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_HEARTBEATS,
			totalItems: this.heartbeats.length,
			reservedRows: HEARTBEAT_LIST_RESERVED_ROWS + (this.error ? 2 : 0),
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: HEARTBEAT_SCROLL_INDICATOR_ROWS,
		});
	}

	private formatStatus(heartbeat: AgentConnectionHeartbeat): string {
		return heartbeat.job.status === "active" ? theme.fg("success", "active") : theme.fg("warning", "paused");
	}

	private formatHeartbeatDetails(heartbeat: AgentConnectionHeartbeat): string {
		const source = heartbeat.job.source === "heartbeat" ? "User" : "Agent";
		const delivery = heartbeat.job.deliveryMode === "follow_up" ? "follow-up" : "steer";
		const next = heartbeat.job.nextRunAt ? this.formatTimestamp(heartbeat.job.nextRunAt) : "—";
		return `${source} · ${this.sessionLabel(heartbeat)} · ${heartbeat.job.status} · ${heartbeat.job.schedule.expression} · ${delivery} · next ${next} · ${heartbeat.job.runCount} runs`;
	}

	private actionDescription(action: AgentHeartbeatManagementAction | "back"): string {
		switch (action) {
			case "pause":
				return "Stop deliveries until resumed";
			case "resume":
				return "Continue scheduled deliveries";
			case "stop":
				return "Permanently remove this heartbeat";
			case "back":
				return "Return to all heartbeats";
		}
	}

	private singleLine(value: string): string {
		return value.replace(/\s+/g, " ").trim();
	}

	private formatTimestamp(value: string): string {
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) return value;
		return parsed.toISOString().slice(0, 16).replace("T", " ");
	}
}
