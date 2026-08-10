import { vi } from "vitest";

const targetTransportTrap = vi.hoisted(() => ({
	attempts: [] as string[],
	attempt(api: string): never {
		this.attempts.push(api);
		throw new Error(`Unexpected target transport attempt: ${api}`);
	},
}));

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		messages = { create: () => targetTransportTrap.attempt("anthropic") };
	}
	return { default: FakeAnthropic };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	class BedrockRuntimeClient {
		send() {
			return targetTransportTrap.attempt("bedrock");
		}
	}
	class ConverseStreamCommand {
		constructor(readonly input: unknown) {}
	}
	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = { generateContentStream: () => targetTransportTrap.attempt("google") };
	}
	return {
		GoogleGenAI,
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			SAFETY: "SAFETY",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			RECITATION: "RECITATION",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			OTHER: "OTHER",
			LANGUAGE: "LANGUAGE",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY" },
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

vi.mock("@mistralai/mistralai", () => {
	class Mistral {
		chat = { stream: () => targetTransportTrap.attempt("mistral") };
	}
	return { Mistral };
});

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = { completions: { create: () => targetTransportTrap.attempt("openai-completions") } };
		responses = { create: () => targetTransportTrap.attempt("openai-responses") };
	}
	class FakeAzureOpenAI extends FakeOpenAI {}
	return { default: FakeOpenAI, AzureOpenAI: FakeAzureOpenAI };
});

export function resetTargetTransportAttempts(): void {
	targetTransportTrap.attempts = [];
}

export function getTargetTransportAttempts(): string[] {
	return [...targetTransportTrap.attempts];
}
