import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentHeartbeatManagementAction } from "../../../core/cron-jobs.js";
import type { AgentConnectionHeartbeat } from "../../agent-connection/types.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";

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
		const safeWidth = Math.max(1, width);
		const active = this.heartbeats.filter((heartbeat) => heartbeat.job.status === "active").length;
		const paused = this.heartbeats.length - active;
		const countLabel = `${this.heartbeats.length} heartbeat${this.heartbeats.length === 1 ? "" : "s"}${paused ? ` · ${paused} paused` : ""}`;
		const header = this.formatLine(
			`${theme.bold("Heartbeats")}  ${theme.fg("muted", countLabel)}  ${theme.fg("dim", keyHint("tui.select.cancel", "close"))}`,
			safeWidth,
		);
		const lines = [header, theme.fg("border", "─".repeat(safeWidth))];
		if (this.mode.type === "list") {
			lines.push(...this.renderList(safeWidth));
		} else {
			lines.push(...this.renderActionMenu(safeWidth, this.mode));
		}
		if (this.error) {
			lines.push(this.formatLine(theme.fg("error", `Error: ${this.error}`), safeWidth));
		}
		return lines;
	}

	private renderList(width: number): string[] {
		if (this.heartbeats.length === 0) {
			return ["", this.formatLine(theme.fg("muted", "No running or paused heartbeats"), width)];
		}
		const body: string[] = [];
		let selectedLine = 0;
		let previousSession: string | undefined;
		for (const [index, heartbeat] of this.heartbeats.entries()) {
			const session = this.sessionLabel(heartbeat);
			if (session !== previousSession) {
				if (body.length > 0) body.push("");
				body.push(this.formatLine(theme.bold(session), width));
				previousSession = session;
			}
			if (index === this.selectedIndex) selectedLine = body.length;
			const source = heartbeat.job.source === "heartbeat" ? "User" : "Agent";
			const label = heartbeat.job.label?.trim();
			const title = `${index === this.selectedIndex ? "›" : " "} ${source}${label ? ` · ${label}` : ""} · ${heartbeat.job.status} · ${heartbeat.job.schedule.expression}`;
			body.push(this.formatLine(index === this.selectedIndex ? theme.fg("accent", title) : title, width));
			body.push(this.formatLine(theme.fg("muted", `  ${this.singleLine(heartbeat.job.prompt)}`), width));
			const delivery = heartbeat.job.deliveryMode === "follow_up" ? "follow-up" : "steer";
			const next = heartbeat.job.nextRunAt ? this.formatTimestamp(heartbeat.job.nextRunAt) : "—";
			body.push(
				this.formatLine(theme.fg("dim", `  next ${next} · ${delivery} · ${heartbeat.job.runCount} runs`), width),
			);
			if (heartbeat.job.lastError) {
				body.push(this.formatLine(theme.fg("error", `  ${this.singleLine(heartbeat.job.lastError)}`), width));
			}
		}
		const maxBodyRows = Math.max(3, this.options.getRows() - 4);
		const start = Math.max(0, Math.min(selectedLine - 2, body.length - maxBodyRows));
		const visible = body.slice(start, start + maxBodyRows);
		visible.push(this.formatLine(theme.fg("dim", keyHint("tui.select.confirm", "manage")), width));
		return visible;
	}

	private renderActionMenu(width: number, mode: Exclude<HeartbeatManagerMode, { type: "list" }>): string[] {
		const heartbeat = this.findHeartbeat(mode.heartbeatId);
		if (!heartbeat) return [this.formatLine(theme.fg("muted", "Heartbeat is no longer available"), width)];
		const source = heartbeat.job.source === "heartbeat" ? "User heartbeat" : "Agent heartbeat";
		const lines = [
			"",
			this.formatLine(theme.bold(heartbeat.job.label?.trim() || source), width),
			this.formatLine(theme.fg("muted", this.singleLine(heartbeat.job.prompt)), width),
			this.formatLine(theme.fg("dim", `${heartbeat.job.status} · ${heartbeat.job.schedule.expression}`), width),
			"",
		];
		if (mode.type === "confirm-stop") {
			lines.push(
				this.formatLine(theme.fg("warning", "Stop this heartbeat? This removes queued deliveries."), width),
			);
			for (const [index, label] of ["Stop heartbeat", "Keep heartbeat"].entries()) {
				lines.push(this.menuLine(label, index === mode.selectedIndex, width));
			}
			return lines;
		}
		for (const [index, action] of this.availableActions(heartbeat).entries()) {
			lines.push(this.menuLine(action.label, index === mode.selectedIndex, width));
		}
		return lines;
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

	private menuLine(label: string, selected: boolean, width: number): string {
		const text = `${selected ? "›" : " "} ${label}`;
		return this.formatLine(selected ? theme.fg("accent", text) : text, width);
	}

	private singleLine(value: string): string {
		return value.replace(/\s+/g, " ").trim();
	}

	private formatTimestamp(value: string): string {
		const parsed = new Date(value);
		if (!Number.isFinite(parsed.getTime())) return value;
		return parsed.toISOString().slice(0, 16).replace("T", " ");
	}

	private formatLine(value: string, width: number): string {
		const truncated = truncateToWidth(value, width, "");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}
}
