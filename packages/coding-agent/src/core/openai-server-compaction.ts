import type { Api, Model } from "@earendil-works/pi-ai";

interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
}

function supportsOpenAIServerCompaction(model: Model<Api>): boolean {
	return (
		(model.api === "openai-responses" && model.provider === "openai") ||
		(model.api === "openai-codex-responses" && model.provider === "openai-codex")
	);
}

function isPayloadObject(payload: unknown): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

export function withOpenAIServerCompaction(payload: unknown, model: Model<Api>, settings: CompactionSettings): unknown {
	if (!settings.enabled || !supportsOpenAIServerCompaction(model) || !isPayloadObject(payload)) {
		return payload;
	}

	const compactThreshold = model.contextWindow - settings.reserveTokens;
	if (!Number.isSafeInteger(compactThreshold) || compactThreshold <= 0) {
		return payload;
	}

	return {
		...payload,
		context_management: [{ type: "compaction", compact_threshold: compactThreshold }],
	};
}
