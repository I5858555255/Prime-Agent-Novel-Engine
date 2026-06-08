import type { TextContent } from "@earendil-works/pi-ai";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CustomMessage } from "../../../core/messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * Component that renders a custom message entry.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private box: Box;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;

	constructor(message: CustomMessage<unknown>, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.message = message;
		this.markdownTheme = markdownTheme;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.removeChild(this.box);

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
