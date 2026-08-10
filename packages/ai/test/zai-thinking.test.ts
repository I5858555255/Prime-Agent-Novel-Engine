import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { stream } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

function makeContext(): Context {
	return {
		messages: [
			{
				role: "user",
				content: "Hello",
				timestamp: Date.now(),
			},
		],
	};
}

interface ZaiPayload {
	thinking?: { type: string; clear_thinking?: boolean };
	reasoning_effort?: string;
	enable_thinking?: boolean;
}

async function capturePayload(
	model: Model<"openai-completions">,
	reasoningEffort?: "low" | "medium" | "high" | "max",
): Promise<ZaiPayload> {
	let captured: ZaiPayload | undefined;

	const s = stream(model, makeContext(), {
		reasoningEffort,
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			captured = payload as ZaiPayload;
			return undefined;
		},
	});

	for await (const event of s) {
		if (event.type === "error") break;
	}

	if (!captured) throw new Error("Expected payload to be captured");
	return captured;
}

describe("Z.AI thinking levels", () => {
	describe("getSupportedThinkingLevels", () => {
		it("returns [off, low, medium, high, max] for glm-5.2", () => {
			const model = getModel("zai", "glm-5.2");
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "max"]);
		});

		it("returns [off, low, medium, high, max] for glm-5.2-highspeed", () => {
			const model = getModel("zai", "glm-5.2-highspeed");
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "max"]);
		});

		it("returns [off, low, medium, high, max] for glm-4.7", () => {
			const model = getModel("zai", "glm-4.7");
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "max"]);
		});

		it("returns [off, low, medium, high, max] for glm-5-turbo", () => {
			const model = getModel("zai", "glm-5-turbo");
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "max"]);
		});
	});

	describe("request params for glm-5.2", () => {
		it("sends thinking.type=enabled with clear_thinking=false and reasoning_effort when effort is high", async () => {
			const model = getModel("zai", "glm-5.2")!;
			const payload = await capturePayload(model, "high");

			expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(payload.reasoning_effort).toBe("high");
			expect(payload.enable_thinking).toBeUndefined();
		});

		it("sends reasoning_effort=max when effort is max", async () => {
			const model = getModel("zai", "glm-5.2")!;
			const payload = await capturePayload(model, "max");

			expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(payload.reasoning_effort).toBe("max");
		});

		it("maps low effort to reasoning_effort=high (alias)", async () => {
			const model = getModel("zai", "glm-5.2")!;
			const payload = await capturePayload(model, "low");

			expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(payload.reasoning_effort).toBe("high");
		});

		it("maps medium effort to reasoning_effort=high (alias)", async () => {
			const model = getModel("zai", "glm-5.2")!;
			const payload = await capturePayload(model, "medium");

			expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(payload.reasoning_effort).toBe("high");
		});

		it("sends thinking.type=disabled when reasoning is off (no reasoningEffort)", async () => {
			const model = getModel("zai", "glm-5.2")!;
			const payload = await capturePayload(model);

			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.reasoning_effort).toBeUndefined();
			expect(payload.enable_thinking).toBeUndefined();
		});
	});

	describe("request params for glm-4.7", () => {
		it("sends thinking.type=enabled with clear_thinking=false and reasoning_effort when effort is high", async () => {
			const model = getModel("zai", "glm-4.7")!;
			const payload = await capturePayload(model, "high");

			expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(payload.reasoning_effort).toBe("high");
			expect(payload.enable_thinking).toBeUndefined();
		});

		it("sends reasoning_effort=max when effort is max", async () => {
			const model = getModel("zai", "glm-4.7")!;
			const payload = await capturePayload(model, "max");

			expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(payload.reasoning_effort).toBe("max");
		});

		it("sends thinking.type=disabled when reasoning is off", async () => {
			const model = getModel("zai", "glm-4.7")!;
			const payload = await capturePayload(model);

			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.reasoning_effort).toBeUndefined();
		});
	});

	describe("request params for glm-5-turbo", () => {
		it("sends thinking.type=enabled with clear_thinking=false and reasoning_effort when effort is high", async () => {
			const model = getModel("zai", "glm-5-turbo")!;
			const payload = await capturePayload(model, "high");

			expect(payload.thinking).toEqual({ type: "enabled", clear_thinking: false });
			expect(payload.reasoning_effort).toBe("high");
			expect(payload.enable_thinking).toBeUndefined();
		});

		it("sends thinking.type=disabled when reasoning is off", async () => {
			const model = getModel("zai", "glm-5-turbo")!;
			const payload = await capturePayload(model);

			expect(payload.thinking).toEqual({ type: "disabled" });
			expect(payload.reasoning_effort).toBeUndefined();
		});
	});
});
