import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createHarness, type Harness } from "../harness.js";

function overloadedMessage(retryAfterMs?: number): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Provider overloaded (overloaded_error, 529)",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "overloaded", status: 529, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
			},
		],
	};
}

describe("issue #688 retry backoff cap, jitter, and Retry-After", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("defaults to 10 attempts, a 60s backoff cap, and a 5m Retry-After ceiling", () => {
		const settings = SettingsManager.inMemory().getRetrySettings();
		expect(settings.maxRetries).toBe(10);
		expect(settings.baseDelayMs).toBe(2000);
		expect(settings.maxBackoffMs).toBe(60_000);
		expect(settings.maxRetryAfterMs).toBe(300_000);
	});

	it("caps each backoff delay at maxBackoffMs", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 400, maxBackoffMs: 25 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloadedMessage(), overloadedMessage(), overloadedMessage(), fauxAssistantMessage("ok")]);

		await harness.session.prompt("test");

		const delays = harness.eventsOfType("auto_retry_start").map((event) => event.delayMs);
		expect(delays).toHaveLength(3);
		for (const delay of delays) {
			expect(delay).toBeLessThanOrEqual(25);
		}
	});

	it("draws full-jitter delays within the exponential envelope", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50, maxBackoffMs: 60_000 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloadedMessage(), overloadedMessage(), fauxAssistantMessage("ok")]);

		await harness.session.prompt("test");

		const delays = harness.eventsOfType("auto_retry_start").map((event) => event.delayMs);
		expect(delays).toHaveLength(2);
		expect(delays[0]).toBeGreaterThanOrEqual(0);
		expect(delays[0]).toBeLessThanOrEqual(50);
		expect(delays[1]).toBeGreaterThanOrEqual(0);
		expect(delays[1]).toBeLessThanOrEqual(100);
	});

	it("uses the server Retry-After as the delay floor", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxBackoffMs: 500 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloadedMessage(120), fauxAssistantMessage("ok")]);

		await harness.session.prompt("test");

		const delays = harness.eventsOfType("auto_retry_start").map((event) => event.delayMs);
		expect(delays).toEqual([120]);
	});

	it("honors a server Retry-After beyond maxBackoffMs", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxBackoffMs: 40 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloadedMessage(120), fauxAssistantMessage("ok")]);

		await harness.session.prompt("test");

		const delays = harness.eventsOfType("auto_retry_start").map((event) => event.delayMs);
		expect(delays).toEqual([120]);
	});

	it("stops retrying when Retry-After exceeds maxRetryAfterMs", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1, maxBackoffMs: 40, maxRetryAfterMs: 200 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloadedMessage(5_000)]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isRetrying).toBe(false);

		const assistantMessages = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const finalAssistant = assistantMessages[assistantMessages.length - 1];
		expect(finalAssistant?.errorMessage).toContain("retry.maxRetryAfterMs");
	});

	it("ends an active retry sequence when a later Retry-After exceeds maxRetryAfterMs", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1, maxBackoffMs: 40, maxRetryAfterMs: 200 } },
		});
		harnesses.push(harness);
		harness.setResponses([overloadedMessage(), overloadedMessage(5_000)]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		const endEvents = harness.eventsOfType("auto_retry_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]?.success).toBe(false);
		expect(endEvents[0]?.finalError).toContain("retry.maxRetryAfterMs");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.isRetrying).toBe(false);
	});
});
