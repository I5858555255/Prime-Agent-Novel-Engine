import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("issue #4435 auth error login guidance", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("adds /login guidance to provider authentication errors", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "401 Unauthorized: invalid API key",
			}),
		]);

		await harness.session.prompt("hello");

		const assistantMessages = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistantMessages[0]?.errorMessage).toContain("Run /login to update credentials.");
		expect(assistantMessages[0]?.errorMessage).not.toContain("/login faux");
	});
});
