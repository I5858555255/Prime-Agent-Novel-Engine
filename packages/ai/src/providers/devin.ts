import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import type {
	Api,
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
import { parseStreamingJson } from "../utils/json-parse.js";
import { recordStreamFailure } from "../utils/stream-failure.js";
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "./devin/proto/exa/api_server_pb/api_server_pb.js";
import { GetUserJwtRequestSchema, GetUserJwtResponseSchema } from "./devin/proto/exa/auth_pb/auth_pb.js";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	PromptCacheOptionsSchema,
} from "./devin/proto/exa/chat_pb/chat_pb.js";
import {
	ChatMessageSource,
	type ChatToolCall,
	ChatToolCallSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	ImageDataSchema,
	MetadataSchema,
	StopReason,
} from "./devin/proto/exa/codeium_common_pb/codeium_common_pb.js";
import { buildBaseOptions } from "./simple-options.js";
import { transformMessages } from "./transform-messages.js";

/** Base host for Codeium/Windsurf's Cascade chat API (Connect protocol over HTTP/1.1). */
export const DEVIN_API_URL = "https://server.codeium.com";

export interface DevinOptions extends StreamOptions {
	/** Cascade conversation id; reused as `cascade_id` so the server threads turns. */
	conversationId?: string;
	/** Wire model uid selected after thinking-effort routing. */
	chatModelUid?: string;
	/** Injectable transport for tests and custom runtimes. */
	fetch?: typeof fetch;
	topP?: number;
	stopSequences?: string[];
}

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_IDE_VERSION = "3.2.23";
const DEVIN_EXTENSION_VERSION = "1.48.2";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

/** Connect streaming framing: flag byte bit 0x01 = gzip payload, 0x02 = end-of-stream JSON trailers. */
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
/**
 * Hard upper bound on a single Connect frame payload. The 4-byte length prefix
 * is attacker-controlled up to `2**32 - 1`; validate it before allocating the
 * frame buffer. This remains well above legitimate Cascade responses but makes
 * a corrupt prefix fail before consuming unbounded memory.
 */
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
/**
 * Recovery heuristic for opaque Devin `invalid_argument` trailers. This is not
 * asserted to be the backend's hard limit: small requests can hit the same
 * intermittent error, while compactable message history this large is likely
 * to benefit from the existing context-overflow maintenance path.
 */
const LARGE_HISTORY_RECOVERY_BYTES = 512 * 1024;

const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

interface ConnectFrame {
	flag: number;
	payload: Buffer;
}

interface StreamingToolCall {
	block: ToolCall;
	partialJson: string;
	lastParsedLength: number;
}

function readConnectFrameLength(buffer: Buffer, offset: number): number {
	const length = buffer.readUInt32BE(offset);
	if (length > MAX_CONNECT_FRAME_PAYLOAD) {
		throw new Error(`Devin Connect frame length ${length} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`);
	}
	return length;
}

async function* readConnectFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<ConnectFrame> {
	const reader = body.getReader();
	const header = Buffer.allocUnsafe(5);
	let headerLength = 0;
	let frameFlag = 0;
	let framePayload: Buffer | undefined;
	let frameOffset = 0;
	let reachedEnd = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				reachedEnd = true;
				break;
			}
			if (!value || value.length === 0) continue;

			const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
			let chunkOffset = 0;
			while (chunkOffset < chunk.length) {
				if (framePayload) {
					const copyLength = Math.min(framePayload.length - frameOffset, chunk.length - chunkOffset);
					chunk.copy(framePayload, frameOffset, chunkOffset, chunkOffset + copyLength);
					frameOffset += copyLength;
					chunkOffset += copyLength;
					if (frameOffset === framePayload.length) {
						const payload = framePayload;
						framePayload = undefined;
						frameOffset = 0;
						yield { flag: frameFlag, payload };
					}
					continue;
				}

				if (headerLength > 0 || chunk.length - chunkOffset < 5) {
					const copyLength = Math.min(5 - headerLength, chunk.length - chunkOffset);
					chunk.copy(header, headerLength, chunkOffset, chunkOffset + copyLength);
					headerLength += copyLength;
					chunkOffset += copyLength;
					if (headerLength < 5) continue;

					frameFlag = header[0];
					const frameLength = readConnectFrameLength(header, 1);
					headerLength = 0;
					if (frameLength === 0) {
						yield { flag: frameFlag, payload: Buffer.alloc(0) };
					} else {
						framePayload = Buffer.allocUnsafe(frameLength);
					}
					continue;
				}

				const flag = chunk[chunkOffset];
				const frameLength = readConnectFrameLength(chunk, chunkOffset + 1);
				chunkOffset += 5;
				if (chunk.length - chunkOffset >= frameLength) {
					const payload = chunk.subarray(chunkOffset, chunkOffset + frameLength);
					chunkOffset += frameLength;
					yield { flag, payload };
				} else {
					frameFlag = flag;
					framePayload = Buffer.allocUnsafe(frameLength);
				}
			}
		}
	} finally {
		if (!reachedEnd) {
			try {
				await reader.cancel();
			} catch {
				// Preserve the frame-processing error that triggered cancellation.
			}
		}
		reader.releaseLock();
	}
}

function parseStreamingJsonThrottled<T = Record<string, unknown>>(
	partialJson: string,
	lastParsedLength: number,
): { value: T; parsedLength: number } | null {
	const length = partialJson.length;
	if (length === 0 || (lastParsedLength > 0 && length - lastParsedLength < STREAMING_JSON_PARSE_MIN_GROWTH)) {
		return null;
	}
	return { value: parseStreamingJson<T>(partialJson), parsedLength: length };
}

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
			api: "devin-agent" as Api,
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
		// Keep streamed content and incremental parse progress together per tool call.
		const toolCalls = new Map<string, StreamingToolCall>();
		let activeToolCallId: string | undefined;
		let latestStopReason = StopReason.UNSPECIFIED;

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

		try {
			const fetchImpl = options?.fetch ?? fetch;
			const baseUrl = (model.baseUrl || DEVIN_API_URL).replace(/\/+$/, "");
			const rawApiKey = options?.apiKey ?? getEnvApiKey(model.provider);
			if (!rawApiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const apiKey = normalizeDevinSessionToken(rawApiKey);
			const auth = await fetchDevinAuthMetadata(apiKey, baseUrl, fetchImpl, options?.signal);
			const chatBaseUrl = auth.baseUrl ?? baseUrl;
			const request = buildDevinChatRequest(model, context, options, apiKey, auth.userJwt);
			const reqBytes = toBinary(GetChatMessageRequestSchema, request);
			const gz = gzipSync(reqBytes);
			const frame = Buffer.alloc(5 + gz.length);
			frame[0] = CONNECT_COMPRESSED_FLAG;
			frame.writeUInt32BE(gz.length, 1);
			frame.set(gz, 5);

			const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
				method: "POST",
				headers: {
					"content-type": "application/connect+proto",
					"connect-protocol-version": "1",
					"connect-content-encoding": "gzip",
					"accept-encoding": "identity",
					"user-agent": "connect-go/1.18.1 (go1.26.3)",
					"connect-accept-encoding": "gzip",
					...(options?.headers ?? {}),
				},
				body: frame,
				signal: options?.signal,
			});

			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Devin API error ${response.status} ${response.statusText}: ${text}`);
			}
			if (!response.body) {
				throw new Error("Devin API error: response body is empty");
			}
			const body = response.body;

			stream.push({ type: "start", partial: output });

			for await (const { flag, payload } of readConnectFrames(body)) {
				if (flag & CONNECT_END_STREAM_FLAG) {
					const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
					const trailerError = readConnectTrailerError(trailerBytes.toString("utf8").trim());
					if (trailerError) {
						let message = trailerError.formatted;
						if (
							trailerError.code.toLowerCase() === "invalid_argument" &&
							/\binternal error\b/i.test(trailerError.message)
						) {
							const shrinkablePrompts =
								context.messages.at(-1)?.role === "user"
									? request.chatMessagePrompts.slice(0, -1)
									: request.chatMessagePrompts;
							const historyBytes = toBinary(
								GetChatMessageRequestSchema,
								create(GetChatMessageRequestSchema, {
									chatMessagePrompts: shrinkablePrompts,
								}),
							).byteLength;
							if (historyBytes >= LARGE_HISTORY_RECOVERY_BYTES) {
								message = `Devin context window exceeds limit: ${message}`;
							}
						}
						throw new Error(message);
					}
					continue;
				}

				const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
				const msg = fromBinary(GetChatMessageResponseSchema, raw);
				if (msg.messageId && !output.responseId) output.responseId = msg.messageId;

				if (msg.deltaThinking) {
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
					block.thinking += msg.deltaThinking;
					if (msg.deltaSignature) block.thinkingSignature = msg.deltaSignature;
					stream.push({
						type: "thinking_delta",
						contentIndex: output.content.indexOf(block),
						delta: msg.deltaThinking,
						partial: output,
					});
				}

				if (msg.deltaText) {
					endThinkingBlock();
					const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
					if (currentTextBlock !== block) {
						output.content.push(block);
						currentTextBlock = block;
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					}
					block.text += msg.deltaText;
					stream.push({
						type: "text_delta",
						contentIndex: output.content.indexOf(block),
						delta: msg.deltaText,
						partial: output,
					});
				}

				if (msg.deltaToolCalls.length > 0) {
					endTextBlock();
					endThinkingBlock();
					for (const tc of msg.deltaToolCalls) {
						const toolCallId = tc.id || activeToolCallId;
						if (!toolCallId) continue;
						let toolCall = toolCalls.get(toolCallId);
						if (!toolCall) {
							const block: ToolCall = { type: "toolCall", id: toolCallId, name: tc.name, arguments: {} };
							toolCall = { block, partialJson: "", lastParsedLength: 0 };
							output.content.push(block);
							toolCalls.set(toolCallId, toolCall);
							stream.push({
								type: "toolcall_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						const { block } = toolCall;
						if (tc.name) block.name = tc.name;
						activeToolCallId = toolCallId;
						if (!tc.argumentsJson) continue;
						const accumulated = tc.argumentsJson.startsWith(toolCall.partialJson)
							? tc.argumentsJson
							: toolCall.partialJson + tc.argumentsJson;
						const delta = accumulated.slice(toolCall.partialJson.length);
						toolCall.partialJson = accumulated;
						const throttled = parseStreamingJsonThrottled(accumulated, toolCall.lastParsedLength);
						if (throttled) {
							block.arguments = throttled.value;
							toolCall.lastParsedLength = throttled.parsedLength;
						}
						stream.push({
							type: "toolcall_delta",
							contentIndex: output.content.indexOf(block),
							delta,
							partial: output,
						});
					}
				}

				if (msg.stopReason !== StopReason.UNSPECIFIED) {
					latestStopReason = msg.stopReason;
				}

				if (msg.usage) {
					output.usage.input = Number(msg.usage.inputTokens);
					output.usage.output = Number(msg.usage.outputTokens);
					output.usage.cacheRead = Number(msg.usage.cacheReadTokens);
					output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens);
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				}
			}

			endTextBlock();
			endThinkingBlock();
			for (const { block, partialJson } of toolCalls.values()) {
				block.arguments = parseStreamingJson(partialJson);
				stream.push({
					type: "toolcall_end",
					contentIndex: output.content.indexOf(block),
					toolCall: block,
					partial: output,
				});
			}

			const doneReason: "stop" | "length" | "toolUse" =
				toolCalls.size > 0 ? "toolUse" : latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop";
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

function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

async function fetchDevinAuthMetadata(
	apiKey: string,
	baseUrl: string,
	fetchImpl: NonNullable<DevinOptions["fetch"]>,
	signal: AbortSignal | undefined,
): Promise<{ userJwt: string; baseUrl?: string }> {
	const request = create(GetUserJwtRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			ideName: "windsurf",
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: "windsurf",
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
	});
	const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body: toBinary(GetUserJwtRequestSchema, request),
		signal,
	});
	const payload = new Uint8Array(await response.arrayBuffer());
	if (!response.ok) {
		throw new Error(
			`Devin auth error ${response.status} ${response.statusText}: ${new TextDecoder().decode(payload)}`,
		);
	}
	const decoded = decodeDevinUserJwtResponse(payload);
	if (!decoded.userJwt) {
		throw new Error("Devin auth error: GetUserJwt returned an empty user JWT");
	}
	const customBaseUrl = decoded.customApiServerUrl.trim();
	return { userJwt: decoded.userJwt, ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined) };
}

function decodeDevinUserJwtResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetUserJwtResponseSchema, payload);
	} catch {
		return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
	}
}

/**
 * Build a {@link GetChatMessageRequest} for one Cascade turn. Auth rides inside
 * `Metadata.apiKey`; the system prompt is the flattened `prompt` string and the
 * conversation history maps to `chatMessagePrompts`.
 */
function buildDevinChatRequest(
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
	apiKey: string,
	userJwt: string,
) {
	const cascadeId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
	const stopPatterns =
		options?.stopSequences && options.stopSequences.length > 0
			? [...DEVIN_DEFAULT_STOP_PATTERNS, ...options.stopSequences]
			: DEVIN_DEFAULT_STOP_PATTERNS;
	const messages = transformMessages(context.messages, model);
	return create(GetChatMessageRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			userJwt,
			ideName: "windsurf",
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: "windsurf",
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
		prompt: context.systemPrompt ?? "",
		chatMessagePrompts: buildChatMessagePrompts(messages, cascadeId, model),
		chatModelUid: options?.chatModelUid ?? model.id,
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		disableParallelToolCalls: true,
		cascadeId,
		executionId: crypto.randomUUID(),
		configuration: create(CompletionConfigurationSchema, {
			numCompletions: 1n,
			maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
			maxNewlines: 200n,
			temperature: options?.temperature ?? 0.4,
			firstTemperature: options?.temperature ?? 0.4,
			topK: 50n,
			topP: options?.topP ?? 1,
			stopPatterns,
			fimEotProbThreshold: 1,
		}),
		tools: (context.tools ?? []).map((tool: Tool) =>
			create(ChatToolDefinitionSchema, {
				name: tool.name,
				description: tool.description,
				jsonSchemaString: JSON.stringify(tool.parameters),
				strict: false,
			}),
		),
	});
}

/** Map omp `Message` history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM / TOOL channels). */
function buildChatMessagePrompts(
	messages: Message[],
	cascadeId: string,
	model: Model<"devin-agent">,
): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	// messageId seeds are `cascadeId\0index\0role[...]` — prompt text is excluded
	// so ids stay stable across content edits / history rebuilds.
	for (const [index, msg] of messages.entries()) {
		if (msg.role === "user") {
			let promptText = "";
			const images = [];
			if (typeof msg.content === "string") {
				promptText = msg.content;
			} else {
				for (const part of msg.content) {
					if (part.type === "text") {
						promptText += part.text;
					} else if (part.type === "image") {
						images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
					}
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`),
					source: ChatMessageSource.USER,
					prompt: promptText,
					images,
				}),
			);
		} else if (msg.role === "assistant") {
			const isNativeDevinMessage =
				msg.api === model.api && msg.provider === model.provider && msg.model === model.id;
			let promptText = "";
			let thinkingText = "";
			let signature = "";
			const toolCalls: ChatToolCall[] = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					promptText += part.text;
				} else if (part.type === "thinking") {
					thinkingText += part.thinking;
					if (isNativeDevinMessage && !signature && part.thinkingSignature) signature = part.thinkingSignature;
				} else if (part.type === "toolCall") {
					toolCalls.push(
						create(ChatToolCallSchema, {
							id: part.id,
							name: part.name,
							argumentsJson: JSON.stringify(part.arguments),
						}),
					);
				}
			}
			if (!promptText && !thinkingText && !signature && toolCalls.length === 0) continue;
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId:
						isNativeDevinMessage && msg.responseId
							? msg.responseId
							: `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
					source: ChatMessageSource.SYSTEM,
					prompt: promptText,
					thinking: thinkingText,
					signature,
					signatureType: "",
					toolCalls,
				}),
			);
		} else {
			let resultText = "";
			const images = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					resultText += part.text;
				} else if (part.type === "image") {
					images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId}`),
					source: ChatMessageSource.TOOL,
					toolCallId: msg.toolCallId,
					toolResultIsError: msg.isError,
					prompt: resultText,
					images,
				}),
			);
		}
	}
	return prompts;
}

function deterministicUuid(seed: string): string {
	const hex = createHash("sha256").update(seed).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface ConnectTrailerError {
	code: string;
	message: string;
	formatted: string;
}

/**
 * Parse a Connect end-of-stream JSON trailer and return its structured error
 * when it carries `{ error: { code, message } }`, else `null`. The trailer is
 * untrusted server output, so the shape is checked with guards rather than asserted.
 */
function readConnectTrailerError(text: string): ConnectTrailerError | null {
	if (text.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
	const err = parsed.error;
	if (!err || typeof err !== "object") return null;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (!code && !message) return null;
	return {
		code,
		message,
		formatted: `Devin stream error${code ? ` ${code}` : ""}: ${message}`,
	};
}
