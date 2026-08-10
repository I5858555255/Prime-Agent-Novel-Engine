import { describe, expect, it } from "vitest";
import type { MODELS } from "../src/models.generated.js";
import { getModel } from "../src/models.js";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { CacheRetention, Context, Model } from "../src/types.js";

type BedrockModelId = keyof (typeof MODELS)["amazon-bedrock"];

interface BedrockCachePayload {
	system?: Array<{ text?: string; cachePoint?: { type: string; ttl?: string } }>;
	messages?: Array<{
		role: string;
		content?: Array<{ text?: string; cachePoint?: { type: string; ttl?: string } }>;
	}>;
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockCachePayload> {
	let capturedPayload: BedrockCachePayload | undefined;
	const s = streamBedrock(model, makeContext(), {
		...options,
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload as BedrockCachePayload;
			return payload;
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

function systemCachePoints(payload: BedrockCachePayload): number {
	return (payload.system ?? []).filter((block) => block.cachePoint !== undefined).length;
}

function lastMessageCachePoints(payload: BedrockCachePayload): number {
	const messages = payload.messages ?? [];
	const last = messages[messages.length - 1];
	return (last?.content ?? []).filter((block) => block.cachePoint !== undefined).length;
}

async function cachePointsFor(
	modelId: BedrockModelId,
	cacheRetention?: CacheRetention,
): Promise<{ system: number; lastMessage: number }> {
	const model = getModel("amazon-bedrock", modelId);
	const payload = await capturePayload(model, cacheRetention ? { cacheRetention } : undefined);
	return { system: systemCachePoints(payload), lastMessage: lastMessageCachePoints(payload) };
}

describe("Bedrock prompt caching", () => {
	// A model missing from the version gate is billed at full input price on every
	// request with no error, so each supported family is asserted explicitly.
	const cachingModels: BedrockModelId[] = [
		"us.anthropic.claude-opus-5",
		"global.anthropic.claude-opus-5",
		"global.anthropic.claude-sonnet-5",
		"global.anthropic.claude-fable-5",
		"global.anthropic.claude-opus-4-8",
		"global.anthropic.claude-opus-4-6-v1",
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		"us.anthropic.claude-haiku-4-5-20251001-v1:0",
	];

	it.each(cachingModels)("emits cache points for %s", async (modelId) => {
		const points = await cachePointsFor(modelId);
		expect(points.system).toBe(1);
		expect(points.lastMessage).toBe(1);
	});

	it("omits cache points for models without prompt cache support", async () => {
		const points = await cachePointsFor("amazon.nova-pro-v1:0");
		expect(points.system).toBe(0);
		expect(points.lastMessage).toBe(0);
	});

	it("omits cache points when caching is disabled", async () => {
		const points = await cachePointsFor("us.anthropic.claude-opus-5", "none");
		expect(points.system).toBe(0);
		expect(points.lastMessage).toBe(0);
	});

	it("requests a one hour ttl for long retention", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-5");
		const payload = await capturePayload(model, { cacheRetention: "long" });
		const cachePoint = (payload.system ?? []).find((block) => block.cachePoint !== undefined);
		expect(cachePoint?.cachePoint?.ttl).toBe("1h");
	});
});
