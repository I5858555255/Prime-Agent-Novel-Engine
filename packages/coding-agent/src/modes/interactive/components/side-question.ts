import { type Component, Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionSideQuestionEvent } from "../../agent-connection/types.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

interface SideQuestionTurnState {
	event: AgentConnectionSideQuestionEvent;
	answer: Markdown;
}

export class SideQuestionComponent implements Component {
	private readonly paddingX: number;
	private readonly turns: SideQuestionTurnState[] = [];

	constructor(event: AgentConnectionSideQuestionEvent, paddingX = 2) {
		this.paddingX = Math.max(2, paddingX);
		this.addTurn(event);
	}

	addTurn(event: AgentConnectionSideQuestionEvent): void {
		const answer = new Markdown("", this.paddingX, 0, getMarkdownTheme(), {
			color: (content: string) => theme.fg("userMessageText", content),
		});
		answer.setText(event.answer);
		this.turns.push({ event, answer });
	}

	update(event: AgentConnectionSideQuestionEvent): void {
		const turn = this.turns.find((candidate) => candidate.event.id === event.id);
		if (!turn) {
			return;
		}
		turn.event = event;
		turn.answer.setText(event.answer);
	}

	invalidate(): void {
		for (const turn of this.turns) {
			turn.answer.invalidate();
		}
	}

	render(width: number): string[] {
		const blank = " ".repeat(Math.max(1, width));
		const lines = [blank];
		for (const [index, turn] of this.turns.entries()) {
			const prefix = index === 0 ? "/btw" : "   ↳";
			const question = new Text(
				`${theme.fg("accent", prefix)}  ${theme.bold(theme.fg("userMessageText", turn.event.question))}`,
				this.paddingX,
				0,
			).render(width);
			lines.push(...question, blank, ...this.renderAnswer(turn, width), blank);
		}
		lines.push(...this.renderHint(width), blank);
		return lines.map((line) => this.applySurface(line, width));
	}

	private renderAnswer(turn: SideQuestionTurnState, width: number): string[] {
		if (turn.event.answer) {
			return turn.answer.render(width);
		}
		if (turn.event.errorMessage) {
			return new Text(theme.fg("error", turn.event.errorMessage), this.paddingX, 0).render(width);
		}
		if (turn.event.status === "cancelled") {
			return new Text(theme.fg("userMessageText", "Cancelled"), this.paddingX, 0).render(width);
		}
		const message = turn.event.status === "complete" ? "No response" : "Thinking…";
		return new Text(theme.fg("userMessageText", message), this.paddingX, 0).render(width);
	}

	private renderHint(width: number): string[] {
		const running = this.turns.at(-1)?.event.status === "running";
		const hint = running ? "esc to cancel and return to session" : "reply to follow up · esc to return to session";
		return new Text(theme.fg("dim", hint), this.paddingX, 0).render(width);
	}

	private applySurface(line: string, width: number): string {
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const background = theme.getPopupBackgroundColor();
		return padded
			.split("\x1b[0m")
			.map((segment) => background(segment))
			.join("\x1b[0m");
	}
}
