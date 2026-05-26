import {
	type Component,
	Container,
	type Focusable,
	Input,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

interface MenuPanelOptions {
	title: string;
	subtitle?: string;
}

const PANEL_PADDING_X = 2;
const PANEL_PADDING_Y = 1;
const FIELD_PADDING_X = 2;

export class MenuPanel extends Container {
	private title: string;

	constructor(private readonly options: MenuPanelOptions) {
		super();
		this.title = options.title;
	}

	setTitle(title: string): void {
		this.title = title;
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(PANEL_PADDING_X * 2 + 1, width);
		const innerWidth = Math.max(1, safeWidth - PANEL_PADDING_X * 2);
		const lines: string[] = [];

		for (let i = 0; i < PANEL_PADDING_Y; i++) {
			lines.push(this.surfaceLine("", innerWidth));
		}
		lines.push(this.surfaceLine(theme.bold(theme.fg("text", this.title)), innerWidth));
		if (this.options.subtitle) {
			lines.push(this.surfaceLine(theme.fg("muted", this.options.subtitle), innerWidth));
		}
		lines.push(this.surfaceLine("", innerWidth));

		for (const child of this.children) {
			for (const line of child.render(innerWidth)) {
				lines.push(this.surfaceLine(line, innerWidth));
			}
		}

		for (let i = 0; i < PANEL_PADDING_Y; i++) {
			lines.push(this.surfaceLine("", innerWidth));
		}
		return lines;
	}

	private surfaceLine(text: string, innerWidth: number): string {
		const content = truncateToWidth(text, innerWidth, "");
		const rightPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		const line = " ".repeat(PANEL_PADDING_X) + content + rightPadding + " ".repeat(PANEL_PADDING_X);
		return theme.getEditorBackgroundColor()?.(line) ?? line;
	}
}

export class MenuSearchInput implements Component, Focusable {
	private readonly input = new Input();

	constructor(private readonly placeholder: string) {}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	set onSubmit(handler: ((value: string) => void) | undefined) {
		this.input.onSubmit = handler;
	}

	getValue(): string {
		return this.input.getValue();
	}

	setValue(value: string): void {
		this.input.setValue(value);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(FIELD_PADDING_X * 2 + 1, width);
		const innerWidth = Math.max(1, safeWidth - FIELD_PADDING_X * 2);
		const content =
			this.getValue() === "" && !this.focused
				? theme.fg("dim", this.placeholder)
				: this.stripInputPrompt(this.input.render(innerWidth + 2)[0] ?? "");
		const field = this.padLine(content, innerWidth, FIELD_PADDING_X);
		return [theme.getEditorBackgroundColor()?.(field) ?? field];
	}

	private stripInputPrompt(line: string): string {
		return line.startsWith("> ") ? line.slice(2) : line;
	}

	private padLine(text: string, innerWidth: number, paddingX: number): string {
		const content = truncateToWidth(text, innerWidth, "");
		const rightPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return " ".repeat(paddingX) + content + rightPadding + " ".repeat(paddingX);
	}
}

interface MenuRowOptions {
	primary: string;
	secondary?: string;
	meta?: string;
	selected: boolean;
}

export class MenuRow implements Component {
	constructor(private readonly options: MenuRowOptions) {}

	invalidate(): void {
		// Row render is derived from constructor options.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const meta = this.options.meta ? theme.fg("muted", this.options.meta) : "";
		const secondary = this.options.secondary ? theme.fg("muted", this.options.secondary) : "";
		const primary = this.options.selected
			? theme.bold(theme.fg("text", this.options.primary))
			: theme.fg("text", this.options.primary);
		const left = secondary ? `${primary}  ${secondary}` : primary;
		const metaWidth = visibleWidth(meta);
		const gap = meta ? 2 : 0;
		const leftWidth = Math.max(1, safeWidth - metaWidth - gap);
		const leftText = truncateToWidth(left, leftWidth, "", true);
		const line = meta ? leftText + " ".repeat(gap) + meta : leftText;
		const padded = truncateToWidth(line, safeWidth, "", true);
		return [this.options.selected ? theme.bg("selectedBg", padded) : padded];
	}
}
