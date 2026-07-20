import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { CustomMessage } from "../../../core/messages.js";
import { theme } from "../theme/theme.js";

export class SlashCommandResultMessageComponent extends Container {
	constructor(message: CustomMessage<unknown>) {
		super();
		this.addChild(new Spacer(1));
		const details = message.details as { severity?: "warning" | "error" } | undefined;
		const severity = details?.severity ?? "error";
		const icon = severity === "warning" ? "⚠" : "Error:";
		const color = severity === "warning" ? "warning" : "error";
		const content = typeof message.content === "string" ? message.content : "Command failed";
		this.addChild(new Text(theme.fg(color, `${icon} ${content}`), 1, 0));
	}

	setExpanded(_expanded: boolean): void {}
}
