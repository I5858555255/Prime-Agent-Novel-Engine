import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

interface MenuPanelOptions {
	title: string;
	subtitle?: string;
}

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
		const safeWidth = Math.max(4, width);
		const innerWidth = Math.max(1, safeWidth - 4);
		const lines: string[] = [this.topBorder(safeWidth)];

		if (this.options.subtitle) {
			lines.push(this.wrap(theme.fg("muted", this.options.subtitle), innerWidth));
			lines.push(this.wrap("", innerWidth));
		}

		for (const child of this.children) {
			for (const line of child.render(innerWidth)) {
				lines.push(this.wrap(line, innerWidth));
			}
		}

		lines.push(this.bottomBorder(safeWidth));
		return lines;
	}

	private topBorder(width: number): string {
		const title = ` ${this.title} `;
		const titleWidth = visibleWidth(title);
		const remaining = Math.max(0, width - titleWidth - 2);
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return (
			theme.fg("border", `╭${"─".repeat(left)}`) +
			theme.bold(theme.fg("text", title)) +
			theme.fg("border", `${"─".repeat(right)}╮`)
		);
	}

	private bottomBorder(width: number): string {
		return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private wrap(text: string, innerWidth: number): string {
		const content = truncateToWidth(text, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return theme.fg("border", "│ ") + content + padding + theme.fg("border", " │");
	}
}
