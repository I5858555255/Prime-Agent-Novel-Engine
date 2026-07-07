import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

function provider401Message(): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "401 Unauthorized: invalid API key",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "auth", status: 401 },
			},
		],
	};
}

describe("issue #4491 provider stale after repeated 401", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("retries concrete provider auth failures, then marks current auth stale", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([provider401Message(), provider401Message(), provider401Message()]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);

		const provider = harness.getModel().provider;
		expect(harness.authStorage.hasAuth(provider)).toBe(false);
		expect(harness.authStorage.getAuthStatus(provider)).toEqual({
			configured: false,
			source: "stale",
			label: "expired",
		});

		const assistantMessages = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const finalAssistant = assistantMessages[assistantMessages.length - 1];
		expect(finalAssistant?.errorMessage).toContain("401 Unauthorized");
		expect(finalAssistant?.errorMessage).toContain("Run /login to update credentials.");
	});
});
