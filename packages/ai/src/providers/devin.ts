import {
	type DevinAssistantContentPart,
	type DevinContentPart,
	type DevinMessage,
	type FetchLike,
	streamDevinChat,
} from "widevin";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { recordStreamFailure } from "../utils/stream-failure.js";
import { buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

/** Base host for Codeium/Windsurf's Cascade chat API. */
export const DEVIN_API_URL = "https://server.codeium.com";

export interface DevinOptions extends StreamOptions {
	conversationId?: string;
	chatModelUid?: string;
	fetch?: FetchLike;
	topP?: number;
	stopSequences?: string[];
}
type DevinInputContent = Extract<Message, { role: "user" | "toolResult" }>["content"];

export const streamDevin: StreamFunction<"devin-agent", DevinOptions> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: DevinOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "devin-agent",
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let currentTextBlock: TextContent | null = null;
		let currentThinkingBlock: ThinkingContent | null = null;
		const toolCalls = new Map<string, ToolCall>();

		const endTextBlock = () => {
			const block = currentTextBlock;
			if (!block) return;
			currentTextBlock = null;
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(block),
				content: block.text,
				partial: output,
			});
		};

		const endThinkingBlock = () => {
			const block = currentThinkingBlock;
			if (!block) return;
			currentThinkingBlock = null;
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(block),
				content: block.thinking,
				partial: output,
			});
		};

		const ensureToolCall = (id: string, name: string): ToolCall => {
			const existing = toolCalls.get(id);
			if (existing) {
				if (name) existing.name = name;
				return existing;
			}
			endTextBlock();
			endThinkingBlock();
			const block: ToolCall = { type: "toolCall", id, name, arguments: {} };
			output.content.push(block);
			toolCalls.set(id, block);
			stream.push({
				type: "toolcall_start",
				contentIndex: output.content.length - 1,
				partial: output,
			});
			return block;
		};

		try {
			const rawApiKey = options?.apiKey ?? getEnvApiKey(model.provider);
			if (!rawApiKey) throw new Error(`No API key for provider: ${model.provider}`);

			const messages = toDevinMessages(transformMessages(context.messages, model), model);
			const fetchImpl = createDevinFetch(options?.fetch ?? globalThis.fetch, options?.headers);
			const systemPrompt = context.systemPrompt ? [context.systemPrompt] : [];

			stream.push({ type: "start", partial: output });

			let doneReason: "stop" | "length" | "toolUse" = "stop";
			for await (const event of streamDevinChat({
				token: rawApiKey,
				baseUrl: model.baseUrl || DEVIN_API_URL,
				fetch: fetchImpl,
				model: options?.chatModelUid ?? model.id,
				messages,
				systemPrompt,
				tools: (context.tools ?? []).map(toDevinTool),
				conversationId: options?.conversationId,
				sessionId: options?.sessionId,
				maxTokens: options?.maxTokens ?? model.maxTokens,
				temperature: options?.temperature,
				topP: options?.topP,
				stopSequences: options?.stopSequences,
				signal: options?.signal,
			})) {
				switch (event.type) {
					case "thinking_delta": {
						endTextBlock();
						const block: ThinkingContent = currentThinkingBlock ?? { type: "thinking", thinking: "" };
						if (currentThinkingBlock !== block) {
							output.content.push(block);
							currentThinkingBlock = block;
							stream.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						block.thinking += event.delta;
						if (event.signature) block.thinkingSignature = event.signature;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(block),
							delta: event.delta,
							partial: output,
						});
						break;
					}
					case "text_delta": {
						endThinkingBlock();
						const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
						if (currentTextBlock !== block) {
							output.content.push(block);
							currentTextBlock = block;
							stream.push({
								type: "text_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						block.text += event.delta;
						stream.push({
							type: "text_delta",
							contentIndex: output.content.indexOf(block),
							delta: event.delta,
							partial: output,
						});
						break;
					}
					case "toolcall_start":
						ensureToolCall(event.id, event.name);
						break;
					case "toolcall_delta": {
						const block = ensureToolCall(event.id, "");
						if (event.arguments !== undefined) block.arguments = toToolArguments(event.arguments);
						stream.push({
							type: "toolcall_delta",
							contentIndex: output.content.indexOf(block),
							delta: event.delta,
							partial: output,
						});
						break;
					}
					case "toolcall_end": {
						const block = ensureToolCall(event.id, event.name);
						block.arguments = toToolArguments(event.arguments);
						stream.push({
							type: "toolcall_end",
							contentIndex: output.content.indexOf(block),
							toolCall: block,
							partial: output,
						});
						break;
					}
					case "usage":
						output.usage.input = event.inputTokens;
						output.usage.output = event.outputTokens;
						output.usage.cacheRead = event.cacheReadTokens;
						output.usage.cacheWrite = event.cacheWriteTokens;
						output.usage.totalTokens =
							event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
						break;
					case "done":
						doneReason = event.reason;
						break;
				}
			}

			endTextBlock();
			endThinkingBlock();
			output.stopReason = doneReason;
			calculateCost(model, output.usage);
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			recordStreamFailure(model, output, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleDevin: StreamFunction<"devin-agent", SimpleStreamOptions> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey ?? getEnvApiKey(model.provider);
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return streamDevin(model, context, buildBaseOptions(model, options, apiKey));
};

function toDevinMessages(messages: Message[], model: Model<"devin-agent">): DevinMessage[] {
	return messages.flatMap((message): DevinMessage[] => {
		if (message.role === "user") {
			return [{ role: "user", content: toDevinContent(message.content) }];
		}
		if (message.role === "toolResult") {
			return [
				{
					role: "tool",
					toolCallId: message.toolCallId,
					content: toDevinContent(message.content),
					isError: message.isError,
				},
			];
		}

		const native = message.api === model.api && message.provider === model.provider && message.model === model.id;
		const content: DevinAssistantContentPart[] = message.content.map((part) => {
			if (part.type === "text") return { type: "text", text: part.text };
			if (part.type === "thinking") {
				return {
					type: "thinking",
					thinking: part.thinking,
					...(native && part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
				};
			}
			return {
				type: "toolCall",
				id: part.id,
				name: part.name,
				arguments: part.arguments,
			};
		});
		if (content.length === 0) return [];
		return [
			{
				role: "assistant",
				content,
				...(native && message.responseId ? { responseId: message.responseId } : {}),
			},
		];
	});
}

function toDevinContent(content: DevinInputContent): string | DevinContentPart[] {
	if (typeof content === "string") return content;
	return content.flatMap((part): DevinContentPart[] => {
		if (part.type === "text" && typeof part.text === "string") {
			return [{ type: "text", text: part.text }];
		}
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			return [{ type: "image", data: part.data, mimeType: part.mimeType }];
		}
		return [];
	});
}

function toDevinTool(tool: Tool) {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		strict: false,
	};
}

function toToolArguments(value: unknown): ToolCall["arguments"] {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ToolCall["arguments"]) : {};
}

function createDevinFetch(fetchImpl: FetchLike, extraHeaders?: Record<string, string>): FetchLike {
	if (!extraHeaders || Object.keys(extraHeaders).length === 0) return fetchImpl;
	return (input, init) => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		new Headers(init?.headers).forEach((value, key) => {
			headers.set(key, value);
		});
		for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
		return fetchImpl(input, { ...init, headers });
	};
}
