import { Container, Image, Text } from "@earendil-works/pi-tui";
import type { CustomMessage } from "../../../core/messages.js";
import type { PresentedArtifactDetails } from "../../../core/presented-artifacts.js";
import { theme } from "../theme/theme.js";

function isImageContent(value: unknown): value is { type: "image"; data: string; mimeType: string } {
	if (typeof value !== "object" || value === null) return false;
	const content = value as Record<string, unknown>;
	return content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string";
}

function textContent(message: CustomMessage): string | undefined {
	if (typeof message.content === "string") return message.content;
	return message.content.find((item) => item.type === "text")?.text;
}

/** Durable, display-only artifact message with actual terminal image rendering. */
export class PresentedArtifactMessageComponent extends Container {
	setExpanded(_expanded: boolean): void {}

	constructor(message: CustomMessage<PresentedArtifactDetails>, showImages = true) {
		super();
		const details = message.details;
		const label =
			textContent(message) ?? details?.label ?? (details?.name ? `Artifact: ${details.name}` : "Artifact");
		this.addChild(new Text(theme.fg("muted", label), 0, 0));

		if (details?.kind === "image" && Array.isArray(message.content)) {
			const image = message.content.find(isImageContent);
			if (image) {
				this.addChild(
					new Image(
						image.data,
						image.mimeType,
						{ fallbackColor: (value) => theme.fg("muted", value) },
						{ filename: details.name, fallbackOnly: !showImages },
						details.width && details.height ? { widthPx: details.width, heightPx: details.height } : undefined,
					),
				);
				return;
			}
		}

		if (details?.path) {
			this.addChild(new Text(theme.fg("dim", details.path), 0, 0));
		}
	}
}
