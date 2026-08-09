import { Container, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type CustomMessage, PRESENTED_ARTIFACT_CUSTOM_TYPE } from "../src/core/messages.js";
import type { PresentedArtifactDetails } from "../src/core/presented-artifacts.js";
import { PresentedArtifactMessageComponent } from "../src/modes/interactive/components/presented-artifact-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function message(kind: "image" | "file" = "image"): CustomMessage<PresentedArtifactDetails> {
	const details: PresentedArtifactDetails = {
		artifactId: "0123456789abcdef",
		presentationId: "presentation-1",
		sessionId: "session-1",
		kind,
		name: kind === "image" ? "preview.png" : "report.pdf",
		label: kind === "image" ? "Generated preview" : undefined,
		mimeType: kind === "image" ? "image/png" : "application/pdf",
		byteSize: 68,
		path: `/tmp/${kind === "image" ? "preview.png" : "report.pdf"}`,
		width: kind === "image" ? 1 : undefined,
		height: kind === "image" ? 1 : undefined,
	};
	return {
		role: "custom",
		customType: PRESENTED_ARTIFACT_CUSTOM_TYPE,
		content:
			kind === "image"
				? [
						{ type: "text", text: "Generated preview" },
						{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
					]
				: [{ type: "text", text: "Artifact: report.pdf" }],
		display: true,
		details,
		timestamp: 0,
	};
}

describe("PresentedArtifactMessageComponent", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => resetCapabilitiesCache());

	it("renders actual terminal graphics for presented images", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const output = new PresentedArtifactMessageComponent(message()).render(80).join("\n");
		expect(output).toContain("Generated preview");
		expect(output).toContain("\x1b_G");
	});

	it("provides filename, MIME, and dimensions when graphics are unavailable or hidden", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const visible = new PresentedArtifactMessageComponent(message()).render(80).join("\n");
		expect(visible).toContain("preview.png");
		expect(visible).toContain("image/png");
		expect(visible).toContain("1x1");
		const hidden = new PresentedArtifactMessageComponent(message(), false).render(80).join("\n");
		expect(hidden).toContain("preview.png · image/png · 1×1");
	});

	it("renders durable generic artifact metadata without throwing", () => {
		const output = new PresentedArtifactMessageComponent(message("file")).render(100).join("\n");
		expect(output).toContain("Artifact: report.pdf");
		expect(output).toContain("/tmp/report.pdf");
	});
	it("routes live and replayed custom messages to the artifact renderer", () => {
		const chatContainer = new Container();
		const harness = {
			chatContainer,
			settingsManager: { getShowImages: () => true },
			toolOutputExpanded: false,
		};
		const addMessageToChat = (
			InteractiveMode.prototype as unknown as {
				addMessageToChat(this: typeof harness, value: CustomMessage<PresentedArtifactDetails>): void;
			}
		).addMessageToChat;
		addMessageToChat.call(harness, message());
		expect(chatContainer.children[0]).toBeInstanceOf(PresentedArtifactMessageComponent);
	});
});
