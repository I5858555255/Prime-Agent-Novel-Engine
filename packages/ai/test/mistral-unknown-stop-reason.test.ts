import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import type { Context } from "../src/types.js";

const mistralMock = vi.hoisted(() => ({
	streamYields: [] as Array<{ data: Record<string, unknown> }>,
}));

vi.mock("@mistralai/mistralai", () => {
	class Mistral {
		chat = {
			stream: async function* () {
				for (const event of mistralMock.streamYields) {
					yield event;
				}
			},
		};
	}
	return { Mistral };
});

import { streamMistral } from "../src/providers/mistral.js";

const model = getModel("mistral", "mistral-small-latest");
const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

describe("Mistral unknown stop reason", () => {
	it("does not report an unknown finish reason as successful completion", async () => {
		// An unknown finish reason must not be collapsed into "stop" (success).
		// It must route through the structured failure path with the raw value preserved.
		mistralMock.streamYields = [
			{
				data: {
					id: "mistral-unknown",
					choices: [
						{
							index: 0,
							finishReason: "model_faulted",
							delta: { content: "Hello" },
						},
					],
				},
			},
		];

		const stream = streamMistral(model, context, { apiKey: "fake-key" });
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.stopReasonRaw).toBe("model_faulted");
		expect(result.errorMessage).not.toContain("Unhandled");
	});

	it("still reports a normal stop as successful completion", async () => {
		mistralMock.streamYields = [
			{
				data: {
					id: "mistral-stop",
					choices: [
						{
							index: 0,
							finishReason: "stop",
							delta: { content: "Hello" },
						},
					],
				},
			},
		];

		const stream = streamMistral(model, context, { apiKey: "fake-key" });
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.stopReasonRaw).toBeUndefined();
	});

	it("keeps an absent finish reason as a successful default", async () => {
		mistralMock.streamYields = [
			{
				data: {
					id: "mistral-no-finish-reason",
					choices: [
						{
							index: 0,
							finishReason: null,
							delta: { content: "Hello" },
						},
					],
				},
			},
		];

		const stream = streamMistral(model, context, { apiKey: "fake-key" });
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.stopReasonRaw).toBeUndefined();
	});
});
