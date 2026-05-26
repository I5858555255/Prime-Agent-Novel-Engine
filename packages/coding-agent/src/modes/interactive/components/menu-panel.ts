import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

interface MenuPanelOptions {
	title: string;
	subtitle?: string;
}

const PANEL_PADDING_X = 2;
const PANEL_PADDING_Y = 1;

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
