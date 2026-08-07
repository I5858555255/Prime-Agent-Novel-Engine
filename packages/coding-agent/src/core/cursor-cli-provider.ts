import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdtempSync, rm } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { VERSION } from "../config.js";

export const CURSOR_CLI_PROVIDER_ID = "cursor";
export const CURSOR_CLI_API = "cursor-cli-acp";
export const CURSOR_CLI_AUTH_TOKEN = "cursor-cli";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_STDERR_CHARS = 8_000;
const CURSOR_CLI_ENV_KEYS = [
	"AGENT_CLI_CREDENTIAL_STORE",
	"ALL_PROXY",
	"APPDATA",
	"COMSPEC",
	"DBUS_SESSION_BUS_ADDRESS",
	"HOME",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"NODE_EXTRA_CA_CERTS",
	"NODE_USE_ENV_PROXY",
	"NO_PROXY",
	"PATH",
	"PATHEXT",
	"SHELL",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SystemRoot",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_STATE_HOME",
	"all_proxy",
	"https_proxy",
	"http_proxy",
	"no_proxy",
] as const;
const PASSTHROUGH_RECORD = {
	parse(value: unknown): Record<string, unknown> {
		return isRecord(value) ? value : {};
	},
};

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function getCursorCliModels(): Model<Api>[] {
	return [
		{
			id: "composer-2.5",
			name: "Composer 2.5 (Cursor)",
			api: CURSOR_CLI_API,
			provider: CURSOR_CLI_PROVIDER_ID,
			baseUrl: "cursor-cli://local",
			reasoning: false,
			input: ["text", "image"],
			cost: EMPTY_COST,
			contextWindow: 128_000,
			maxTokens: 32_768,
			featured: true,
		},
		{
			id: "grok-4.5",
			name: "Cursor Grok 4.5",
			api: CURSOR_CLI_API,
			provider: CURSOR_CLI_PROVIDER_ID,
			baseUrl: "cursor-cli://local",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: null,
				max: null,
			},
			input: ["text", "image"],
			cost: EMPTY_COST,
			contextWindow: 128_000,
			maxTokens: 32_768,
			featured: true,
		},
	];
}

export function getCursorCliCommand(): string {
	return process.env.CURSOR_AGENT_PATH?.trim() || "cursor-agent";
}

function getCursorCliEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of CURSOR_CLI_ENV_KEYS) {
		if (process.env[key] !== undefined) {
			env[key] = process.env[key];
		}
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("CURSOR_") && value !== undefined) {
			env[key] = value;
		}
	}
	return env;
}

function executableExists(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function isCursorCliAvailable(): boolean {
	const command = getCursorCliCommand();
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return executableExists(command);
	}

	const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((extension) => extension.toLowerCase())
			: [""];
	for (const directory of pathEntries) {
		for (const extension of extensions) {
			const candidate = join(directory, `${command}${extension}`);
			if (existsSync(candidate) && executableExists(candidate)) {
				return true;
			}
		}
	}
	return false;
}

export function isCursorCliModel(model: Model<Api>): boolean {
	return model.provider === CURSOR_CLI_PROVIDER_ID && model.api === CURSOR_CLI_API;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SerializedContext {
	text: string;
	images: ImageContent[];
}

function serializeContent(
	content: string | Array<TextContent | ThinkingContent | ToolCall | ImageContent>,
	images: ImageContent[],
): unknown {
	if (typeof content === "string") {
		return content;
	}
	return content.map((block) => {
		if (block.type !== "image") {
			return block;
		}
		const imageIndex = images.push(block);
		return { type: "image", image: imageIndex, mimeType: block.mimeType };
	});
}

function serializeMessage(message: Message, images: ImageContent[]): Record<string, unknown> {
	if (message.role === "user") {
		return { role: message.role, content: serializeContent(message.content, images) };
	}
	if (message.role === "assistant") {
		return { role: message.role, content: serializeContent(message.content, images) };
	}
	return {
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: serializeContent(message.content, images),
		isError: message.isError,
	};
}

function normalizeCursorMessages(messages: Message[]): Message[] {
	const normalized: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let toolResultIds = new Set<string>();
	const insertMissingToolResults = () => {
		for (const toolCall of pendingToolCalls) {
			if (!toolResultIds.has(toolCall.id)) {
				normalized.push({
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				} satisfies ToolResultMessage);
			}
		}
		pendingToolCalls = [];
		toolResultIds = new Set();
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			insertMissingToolResults();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				continue;
			}
			const content: AssistantMessage["content"] = [];
			for (const block of message.content) {
				if (block.type === "thinking") {
					if (!block.redacted && block.thinking.trim()) {
						content.push({ type: "text", text: block.thinking });
					}
				} else if (block.type === "toolCall") {
					const toolCall = { ...block };
					delete toolCall.thoughtSignature;
					content.push(toolCall);
				} else {
					content.push({ type: "text", text: block.text });
				}
			}
			const normalizedMessage: AssistantMessage = { ...message, content };
			pendingToolCalls = content.filter((block): block is ToolCall => block.type === "toolCall");
			normalized.push(normalizedMessage);
		} else if (message.role === "toolResult") {
			toolResultIds.add(message.toolCallId);
			normalized.push(message);
		} else {
			insertMissingToolResults();
			normalized.push(message);
		}
	}
	insertMissingToolResults();
	return normalized;
}

function serializeContext(context: Context): SerializedContext {
	const images: ImageContent[] = [];
	const envelope = {
		systemPrompt: context.systemPrompt ?? "",
		messages: normalizeCursorMessages(context.messages).map((message) => serializeMessage(message, images)),
		tools: context.tools ?? [],
	};
	const text = `You are the model inference layer inside Prime Agent. Prime Agent, not Cursor, owns the agent loop and executes tools.

Do not use Cursor tools, inspect the workspace, run commands, or edit files. Treat the request envelope below as the complete conversation. Follow its systemPrompt and messages. If a tool is needed, request it in the response JSON and let Prime Agent execute it.

Return exactly one JSON object with no Markdown fence or surrounding text:
{"content":[{"type":"text","text":"..."}|{"type":"toolCall","name":"exact tool name","arguments":{}}]}

Rules:
- content must be a non-empty array.
- Use only tool names present in the envelope.
- Tool arguments must match the supplied schema.
- You may return text, one or more tool calls, or both.
- Never claim a tool ran before its tool result appears in a later envelope.
- Images referenced as {"type":"image","image":N} are attached after the envelope in one-based order.

<prime_agent_request>
${JSON.stringify(envelope)}
</prime_agent_request>`;
	return { text, images };
}

function flattenSelectOptions(option: SessionConfigOption): Array<{ value: string; name: string }> {
	if (option.type !== "select") {
		return [];
	}
	return option.options.flatMap((entry) =>
		"value" in entry ? [{ value: entry.value, name: entry.name }] : entry.options,
	);
}

function normalizeReasoning(value: string): string {
	return value.trim().toLowerCase().replace(/[ _]+/g, "-").replace("extra-high", "xhigh");
}

function findReasoningValue(option: SessionConfigOption, requested: string): string | undefined {
	const normalizedRequested = normalizeReasoning(requested);
	return flattenSelectOptions(option).find(
		(candidate) =>
			normalizeReasoning(candidate.value) === normalizedRequested ||
			normalizeReasoning(candidate.name) === normalizedRequested,
	)?.value;
}

async function configureCursorSession(
	ctx: acp.ClientContext,
	sessionId: string,
	initialOptions: SessionConfigOption[],
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	signal: AbortSignal,
): Promise<void> {
	const requestOptions = { cancellationSignal: signal };
	const modelOption = initialOptions.find((option) => option.category === "model" || option.id === "model");
	if (!modelOption || !flattenSelectOptions(modelOption).some((option) => option.value === model.id)) {
		throw new Error(`Cursor CLI does not advertise model "${model.id}"`);
	}
	let response = await ctx.request(
		acp.methods.agent.session.setConfigOption,
		{ sessionId, configId: modelOption.id, value: model.id },
		requestOptions,
	);
	let configOptions = response.configOptions;
	if (!configOptions?.some((option) => option.id === modelOption.id && option.currentValue === model.id)) {
		throw new Error(`Cursor CLI did not select model "${model.id}"`);
	}

	if (options?.reasoning) {
		const reasoningOption = configOptions.find(
			(option) => option.category === "thought_level" || option.id === "effort" || option.id === "reasoning",
		);
		const reasoningValue = reasoningOption && findReasoningValue(reasoningOption, options.reasoning);
		if (!reasoningOption || !reasoningValue) {
			throw new Error(`Cursor CLI does not support reasoning level "${options.reasoning}" for "${model.id}"`);
		}
		response = await ctx.request(
			acp.methods.agent.session.setConfigOption,
			{ sessionId, configId: reasoningOption.id, value: reasoningValue },
			requestOptions,
		);
		configOptions = response.configOptions;
		if (
			!configOptions?.some((option) => option.id === reasoningOption.id && option.currentValue === reasoningValue)
		) {
			throw new Error(`Cursor CLI did not select reasoning level "${reasoningValue}"`);
		}
	}

	const fastOption = configOptions.find((option) => option.id === "fast");
	if (fastOption?.type === "select" && fastOption.currentValue === "true") {
		if (!flattenSelectOptions(fastOption).some((option) => option.value === "false")) {
			throw new Error("Cursor CLI cannot disable fast mode for the selected model");
		}
		response = await ctx.request(
			acp.methods.agent.session.setConfigOption,
			{ sessionId, configId: fastOption.id, value: "false" },
			requestOptions,
		);
		configOptions = response.configOptions;
		if (!configOptions?.some((option) => option.id === fastOption.id && option.currentValue === "false")) {
			throw new Error("Cursor CLI did not disable fast mode");
		}
	} else if (fastOption?.type === "boolean" && fastOption.currentValue === true) {
		response = await ctx.request(
			acp.methods.agent.session.setConfigOption,
			{ sessionId, configId: fastOption.id, type: "boolean", value: false },
			requestOptions,
		);
		configOptions = response.configOptions;
		if (!configOptions?.some((option) => option.id === fastOption.id && option.currentValue === false)) {
			throw new Error("Cursor CLI did not disable fast mode");
		}
	}

	const modeOption = configOptions.find((option) => option.category === "mode" || option.id === "mode");
	if (!modeOption || !flattenSelectOptions(modeOption).some((option) => option.value === "ask")) {
		throw new Error("Cursor CLI does not advertise Ask mode");
	}
	response = await ctx.request(
		acp.methods.agent.session.setConfigOption,
		{ sessionId, configId: modeOption.id, value: "ask" },
		requestOptions,
	);
	if (!response.configOptions?.some((option) => option.id === modeOption.id && option.currentValue === "ask")) {
		throw new Error("Cursor CLI did not enter Ask mode");
	}
}

interface CursorResponseText {
	type: "text";
	text: string;
}

interface CursorResponseToolCall {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
}

type CursorResponseContent = CursorResponseText | CursorResponseToolCall;

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		// Cursor occasionally wraps structured output despite the transport instruction.
	}

	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) {
		return JSON.parse(fenced[1].trim()) as unknown;
	}

	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < trimmed.length; index++) {
		const character = trimmed[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			if (depth === 0) start = index;
			depth++;
		} else if (character === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				return JSON.parse(trimmed.slice(start, index + 1)) as unknown;
			}
		}
	}
	throw new Error("Cursor CLI did not return a JSON object");
}

function parseCursorResponse(text: string, tools: Context["tools"]): CursorResponseContent[] {
	const parsed = extractJsonObject(text);
	if (!isRecord(parsed) || !Array.isArray(parsed.content) || parsed.content.length === 0) {
		throw new Error("Cursor CLI returned an invalid response envelope");
	}
	const toolNames = new Set(tools?.map((tool) => tool.name) ?? []);
	return parsed.content.map((block): CursorResponseContent => {
		if (!isRecord(block)) {
			throw new Error("Cursor CLI returned an invalid content block");
		}
		if (block.type === "text" && typeof block.text === "string") {
			return { type: "text", text: block.text };
		}
		if (
			block.type === "toolCall" &&
			typeof block.name === "string" &&
			toolNames.has(block.name) &&
			isRecord(block.arguments)
		) {
			return { type: "toolCall", name: block.name, arguments: block.arguments };
		}
		throw new Error("Cursor CLI returned an invalid or unknown tool call");
	});
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { ...EMPTY_COST, total: 0 },
	};
}

function errorMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function finishStream(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	content: CursorResponseContent[],
	usage: AssistantMessage["usage"],
	lengthLimited: boolean,
): AssistantMessage {
	const finalContent: Array<TextContent | ToolCall> = content.map((block) =>
		block.type === "text"
			? block
			: { type: "toolCall", id: `cursor:${randomUUID()}`, name: block.name, arguments: block.arguments },
	);
	const hasToolCall = finalContent.some((block) => block.type === "toolCall");
	const stopReason = hasToolCall ? "toolUse" : lengthLimited ? "length" : "stop";
	const message: AssistantMessage = {
		role: "assistant",
		content: finalContent,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
	const partial: AssistantMessage = { ...message, content: [] };
	stream.push({ type: "start", partial: { ...partial } });
	for (let index = 0; index < finalContent.length; index++) {
		const block = finalContent[index];
		if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({
				type: "text_start",
				contentIndex: index,
				partial: { ...partial, content: [...partial.content] },
			});
			partial.content = partial.content.map((current, contentIndex) => (contentIndex === index ? block : current));
			stream.push({
				type: "text_delta",
				contentIndex: index,
				delta: block.text,
				partial: { ...partial, content: [...partial.content] },
			});
			stream.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: { ...partial, content: [...partial.content] },
			});
		} else {
			partial.content = [...partial.content, { ...block, arguments: {} }];
			stream.push({
				type: "toolcall_start",
				contentIndex: index,
				partial: { ...partial, content: [...partial.content] },
			});
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: JSON.stringify(block.arguments),
				partial: { ...partial, content: [...partial.content] },
			});
			partial.content = partial.content.map((current, contentIndex) => (contentIndex === index ? block : current));
			stream.push({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: block,
				partial: { ...partial, content: [...partial.content] },
			});
		}
	}
	return message;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const onClose = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			child.removeListener("close", onClose);
			resolve(false);
		}, timeoutMs);
		child.once("close", onClose);
	});
}

function removeCursorCwd(path: string): Promise<void> {
	return new Promise((resolve) => rm(path, { force: true, recursive: true }, () => resolve()));
}

async function runCursor(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
): Promise<void> {
	let timeoutSignal: AbortSignal | undefined;
	let signal: AbortSignal | undefined;
	let cursorCwd: string | undefined;
	let child: ChildProcessWithoutNullStreams | undefined;
	let abortChild: (() => void) | undefined;
	let stderr = "";
	let spawnError: Error | undefined;
	let finalMessage: AssistantMessage | undefined;

	try {
		timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		cursorCwd = mkdtempSync(join(tmpdir(), "prime-agent-cursor-"));
		const spawned = spawn(getCursorCliCommand(), ["acp"], {
			cwd: cursorCwd,
			env: getCursorCliEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		child = spawned;
		spawned.stderr.setEncoding("utf8");
		spawned.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
		});
		spawned.on("error", (error) => {
			spawnError = error;
		});
		abortChild = () => spawned.kill("SIGTERM");
		signal.addEventListener("abort", abortChild, { once: true });
		const requestSignal = signal;
		const sessionCwd = cursorCwd;

		const transport = acp.ndJsonStream(
			Writable.toWeb(spawned.stdin) as WritableStream<Uint8Array>,
			Readable.toWeb(spawned.stdout) as ReadableStream<Uint8Array>,
		);
		const client = acp
			.client({ name: "prime-agent-cursor" })
			.onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
			.onRequest("cursor/ask_question", PASSTHROUGH_RECORD, () => ({ answers: {} }))
			.onRequest("cursor/create_plan", PASSTHROUGH_RECORD, () => ({ accepted: false }))
			.onNotification("cursor/update_todos", PASSTHROUGH_RECORD, () => undefined);
		const result = await client.connectWith(transport, async (ctx) => {
			const requestOptions = { cancellationSignal: requestSignal };
			await ctx.request(
				acp.methods.agent.initialize,
				{
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: false, writeTextFile: false },
						terminal: false,
						_meta: { parameterizedModelPicker: true },
					},
					clientInfo: { name: "prime-agent", version: VERSION },
				},
				requestOptions,
			);
			return ctx.buildSession(sessionCwd).withSession(async (session) => {
				const configOptions = session.newSessionResponse.configOptions ?? [];
				await configureCursorSession(ctx, session.sessionId, configOptions, model, options, requestSignal);
				const serialized = serializeContext(context);
				const prompt: acp.ContentBlock[] = [
					{ type: "text", text: serialized.text },
					...serialized.images.map((image) => ({
						type: "image" as const,
						mimeType: image.mimeType,
						data: image.data,
					})),
				];
				void session.prompt(prompt, requestOptions);
				let output = "";
				for (;;) {
					const update = await session.nextUpdate();
					if (update.kind === "stop") {
						return { output, response: update.response };
					}
					if (update.update.sessionUpdate === "agent_message_chunk" && update.update.content.type === "text") {
						output += update.update.content.text;
					}
				}
			});
		});

		if (result.response.stopReason === "cancelled") {
			throw new DOMException("Request was aborted", "AbortError");
		}
		if (result.response.stopReason === "refusal") {
			throw new Error("Cursor CLI refused the request");
		}
		const parsed = parseCursorResponse(result.output, context.tools);
		const cursorUsage = result.response.usage;
		const usage: AssistantMessage["usage"] = cursorUsage
			? {
					input: cursorUsage.inputTokens,
					output: cursorUsage.outputTokens,
					cacheRead: cursorUsage.cachedReadTokens ?? 0,
					cacheWrite: cursorUsage.cachedWriteTokens ?? 0,
					totalTokens: cursorUsage.totalTokens,
					cost: { ...EMPTY_COST, total: 0 },
				}
			: emptyUsage();
		finalMessage = finishStream(
			stream,
			model,
			parsed,
			usage,
			result.response.stopReason === "max_tokens" || result.response.stopReason === "max_turn_requests",
		);
	} catch (error) {
		const aborted = options?.signal?.aborted === true;
		const timedOut = timeoutSignal?.aborted === true && !aborted;
		const detail =
			spawnError ??
			(timedOut
				? new Error(`Cursor CLI request timed out after ${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`)
				: error);
		const stderrDetail = stderr.trim();
		finalMessage = errorMessage(
			model,
			stderrDetail && !aborted
				? new Error(`${detail instanceof Error ? detail.message : String(detail)}: ${stderrDetail}`)
				: detail,
			aborted,
		);
	} finally {
		if (signal && abortChild) {
			signal.removeEventListener("abort", abortChild);
		}
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			if (!(await waitForChildExit(child, 1_000))) {
				child.kill("SIGKILL");
				await waitForChildExit(child, 1_000);
			}
		}
		if (cursorCwd) {
			await removeCursorCwd(cursorCwd);
		}
	}
	if (!finalMessage) {
		finalMessage = errorMessage(model, new Error("Cursor CLI ended without a result"), false);
	}
	if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
		stream.push({
			type: "error",
			reason: finalMessage.stopReason === "aborted" ? "aborted" : "error",
			error: finalMessage,
		});
	} else {
		stream.push({ type: "done", reason: finalMessage.stopReason, message: finalMessage });
	}
	stream.end(finalMessage);
}

export function streamCursorCli(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runCursor(stream, model, context, options);
	return stream;
}

export function registerCursorCliProvider(): void {
	registerApiProvider(
		{
			api: CURSOR_CLI_API,
			stream: streamCursorCli,
			streamSimple: streamCursorCli,
		},
		"builtin:cursor-cli",
	);
}
