import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { UserMessageComponent } from "./user-message.js";

export function styleSlashCommandText(text: string): string {
	const space = text.search(/\s/);
	const command = space === -1 ? text : text.slice(0, space);
	const rest = space === -1 ? "" : text.slice(space);
	return `${theme.fg("accent", command)}${theme.fg("userMessageText", rest)}`;
}

export class SlashCommandMessageComponent extends UserMessageComponent {
	constructor(text: string, markdownTheme: MarkdownTheme) {
		super(text, markdownTheme, styleSlashCommandText(text));
	}
}
