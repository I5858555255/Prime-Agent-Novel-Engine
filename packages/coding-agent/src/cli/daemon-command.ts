import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import chalk from "chalk";
import { spawn } from "child_process";
import { APP_NAME } from "../config.js";
import type { AgentSessionEvent } from "../core/agent-session.js";
import { DaemonClient, type DaemonClientMessageListener } from "../modes/daemon/daemon-client.js";
import {
	type DaemonOutbound,
	type DaemonResponse,
	type DaemonSessionSummary,
	defaultDaemonSocketPath,
} from "../modes/daemon/daemon-mode.js";

interface ParsedDaemonClientCommand {
	command: string;
	socketPath: string;
	json: boolean;
	positionals: string[];
}

const DAEMON_CLIENT_COMMANDS = new Set([
	"help",
	"start",
	"list",
	"list-saved",
	"create",
	"attach",
	"detach",
	"kill",
	"rename",
	"prompt",
	"steer",
	"follow-up",
	"state",
	"messages",
	"stats",
	"commands",
	"shutdown",
]);

export function normalizeDaemonStartArgs(args: string[]): string[] | undefined {
	if (args[0] !== "daemon" || args[1] !== "start") {
		return undefined;
	}
	if (!args.slice(2).some((arg) => arg === "--foreground" || arg === "--no-detach")) {
		return undefined;
	}

	const normalized = ["--mode", "daemon"];
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--foreground" || arg === "--no-detach" || arg === "--background" || arg === "-d") {
			continue;
		}
		normalized.push(arg === "--socket" ? "--daemon-socket" : arg);
	}
	return normalized;
}

export async function handleDaemonCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "daemon") {
		return false;
	}

	try {
		const parsed = parseDaemonClientCommand(args.slice(1));
		if (parsed.command === "help") {
			printDaemonHelp();
			return true;
		}

		await runDaemonClientCommand(parsed);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function parseDaemonClientCommand(args: string[]): ParsedDaemonClientCommand {
	let socketPath = defaultDaemonSocketPath();
	let json = false;
	const positionals: string[] = [];
	let passthrough = false;
	let command: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];

		if (passthrough) {
			positionals.push(arg);
			continue;
		}

		if (arg === "--") {
			passthrough = true;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			if (!command) {
				command = "help";
			} else {
				positionals.push("help");
			}
			continue;
		}

		if (arg === "--socket" || arg === "--daemon-socket") {
			const value = args[index + 1];
			if (!value) {
				throw new Error(`${arg} requires a value`);
			}
			socketPath = value;
			index++;
			continue;
		}

		if (arg === "--json") {
			json = true;
			continue;
		}

		if (!command && DAEMON_CLIENT_COMMANDS.has(arg)) {
			command = arg;
			continue;
		}

		positionals.push(arg);
	}

	command = command ?? "open";
	if (command !== "open" && !DAEMON_CLIENT_COMMANDS.has(command)) {
		throw new Error(`Unknown daemon command: ${command}`);
	}

	return { command, socketPath, json, positionals };
}

async function runDaemonClientCommand(parsed: ParsedDaemonClientCommand): Promise<void> {
	if (parsed.command === "open") {
		await runOpen(parsed);
		return;
	}

	if (parsed.command === "start") {
		await runStart(parsed);
		return;
	}

	const client = new DaemonClient(parsed.socketPath);
	await client.connect();

	try {
		switch (parsed.command) {
			case "list":
				await runList(client, parsed.json);
				return;
			case "list-saved":
				await printResponseData(client, { type: "list_saved" }, parsed.json);
				return;
			case "create":
				await runCreate(client, parsed.positionals, parsed.json);
				return;
			case "attach":
				if (parsed.json) {
					await runJsonAttach(client, requireSessionId(parsed.positionals));
				} else {
					await runAttach(client, requireSessionId(parsed.positionals));
				}
				return;
			case "detach":
				await printResponseData(
					client,
					parsed.positionals[0] ? { type: "detach", daemonSessionId: parsed.positionals[0] } : { type: "detach" },
					parsed.json,
				);
				return;
			case "kill":
				await printResponseData(
					client,
					{ type: "kill", daemonSessionId: requireSessionId(parsed.positionals) },
					parsed.json,
				);
				return;
			case "rename":
				await runRename(client, parsed.positionals, parsed.json);
				return;
			case "prompt":
				await runPrompt(client, parsed.positionals);
				return;
			case "steer":
				await runMessageCommand(client, "steer", parsed.positionals, parsed.json);
				return;
			case "follow-up":
				await runMessageCommand(client, "follow_up", parsed.positionals, parsed.json);
				return;
			case "state":
				await printResponseData(
					client,
					{ type: "get_state", daemonSessionId: requireSessionId(parsed.positionals) },
					true,
				);
				return;
			case "messages":
				await printResponseData(
					client,
					{ type: "get_messages", daemonSessionId: requireSessionId(parsed.positionals) },
					true,
				);
				return;
			case "stats":
				await printResponseData(
					client,
					{ type: "get_session_stats", daemonSessionId: requireSessionId(parsed.positionals) },
					true,
				);
				return;
			case "commands":
				await printResponseData(
					client,
					{ type: "get_commands", daemonSessionId: requireSessionId(parsed.positionals) },
					true,
				);
				return;
			case "shutdown":
				await printResponseData(client, { type: "shutdown" }, parsed.json);
				return;
		}
	} finally {
		client.close();
	}
}

async function runOpen(parsed: ParsedDaemonClientCommand): Promise<void> {
	const { daemonArgs, name } = parseOpenArgs(parsed.positionals);
	if (!(await canConnectToDaemon(parsed.socketPath, 250))) {
		await runStart({ ...parsed, command: "start", positionals: daemonArgs });
	}

	const client = new DaemonClient(parsed.socketPath);
	await client.connect();
	try {
		const sessions = await getLiveSessions(client);
		const sessionName = name ?? nextDefaultSessionName(sessions);
		const response = await client.request({ type: "create", name: sessionName });
		const data = requireSuccess(response);
		if (!isSessionSummary(data)) {
			throw new Error("Daemon returned an invalid create response");
		}
		await runAttach(client, data.daemonSessionId);
	} finally {
		client.close();
	}
}

interface ParsedOpenArgs {
	daemonArgs: string[];
	name?: string;
}

const DAEMON_START_BOOLEAN_FLAGS = new Set([
	"--continue",
	"-c",
	"--resume",
	"-r",
	"--no-session",
	"--no-tools",
	"-nt",
	"--no-builtin-tools",
	"-nbt",
	"--no-extensions",
	"-ne",
	"--no-skills",
	"-ns",
	"--no-prompt-templates",
	"-np",
	"--no-themes",
	"--no-context-files",
	"-nc",
	"--verbose",
	"--offline",
	"--foreground",
	"--no-detach",
	"--background",
	"-d",
]);

function parseOpenArgs(args: string[]): ParsedOpenArgs {
	const daemonArgs: string[] = [];
	const nameParts: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") {
			nameParts.push(...args.slice(index + 1));
			break;
		}

		if (arg === "--name") {
			const value = args[index + 1];
			if (!value) {
				throw new Error("--name requires a value");
			}
			nameParts.push(value);
			index++;
			continue;
		}

		if (arg.startsWith("-")) {
			daemonArgs.push(arg);
			if (!DAEMON_START_BOOLEAN_FLAGS.has(arg)) {
				const value = args[index + 1];
				if (value && !value.startsWith("-")) {
					daemonArgs.push(value);
					index++;
				}
			}
			continue;
		}

		nameParts.push(arg);
	}

	const name = nameParts.join(" ").trim();
	return { daemonArgs, name: name || undefined };
}

async function getLiveSessions(client: DaemonClient): Promise<DaemonSessionSummary[]> {
	const response = await client.request({ type: "list" });
	const data = requireSuccess(response);
	if (!isSessionListData(data)) {
		throw new Error("Daemon returned an invalid list response");
	}
	return data.sessions;
}

function nextDefaultSessionName(sessions: DaemonSessionSummary[]): string {
	const existingNames = new Set(
		sessions.map((session) => session.sessionName).filter((name): name is string => !!name),
	);
	const numericNames = [...existingNames]
		.map((name) => Number.parseInt(name, 10))
		.filter((value) => Number.isInteger(value) && value > 0);
	let next = numericNames.length > 0 ? Math.max(...numericNames) + 1 : 1;
	while (existingNames.has(String(next))) {
		next++;
	}
	return String(next);
}

async function runStart(parsed: ParsedDaemonClientCommand): Promise<void> {
	if (parsed.positionals.length === 1 && parsed.positionals[0] === "help") {
		printDaemonHelp();
		return;
	}

	if (await canConnectToDaemon(parsed.socketPath, 250)) {
		console.log(`Daemon already running on ${parsed.socketPath}`);
		return;
	}

	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for daemon launch");
	}

	const daemonArgs = [
		...process.execArgv,
		entrypoint,
		"--mode",
		"daemon",
		"--daemon-socket",
		parsed.socketPath,
		...parsed.positionals.filter((arg) => arg !== "--background" && arg !== "-d"),
	];
	const child = spawn(process.execPath, daemonArgs, {
		cwd: process.cwd(),
		detached: true,
		env: process.env,
		stdio: "ignore",
	});
	child.unref();

	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await canConnectToDaemon(parsed.socketPath, 250)) {
			console.log(`Daemon started on ${parsed.socketPath} (pid ${child.pid})`);
			return;
		}
		await delay(100);
	}

	throw new Error(`Timed out waiting for daemon to start on ${parsed.socketPath}`);
}

async function canConnectToDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

async function runList(client: DaemonClient, json: boolean): Promise<void> {
	const response = await client.request({ type: "list" });
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	if (!isSessionListData(data)) {
		printJson(data);
		return;
	}

	if (data.sessions.length === 0) {
		console.log("No live daemon sessions.");
		return;
	}

	const rows = data.sessions.map((session) => ({
		name: session.sessionName ?? "",
		id: session.daemonSessionId,
		messages: String(session.messageCount),
		clients: String(session.attachedClients),
		streaming: session.isStreaming ? "yes" : "no",
		cwd: session.cwd,
	}));
	printTable(["name", "id", "messages", "clients", "streaming", "cwd"], rows);
}

async function runCreate(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const name = args.length > 0 ? args.join(" ") : undefined;
	const response = await client.request(name ? { type: "create", name } : { type: "create" });
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	if (isSessionSummary(data)) {
		console.log(`Created ${data.daemonSessionId}${data.sessionName ? ` (${data.sessionName})` : ""}`);
		return;
	}
	printJson(data);
}

async function runAttach(client: DaemonClient, daemonSessionId: string): Promise<void> {
	const terminal = new DaemonAttachTerminal(client, daemonSessionId);
	await terminal.run();
}

async function runJsonAttach(client: DaemonClient, daemonSessionId: string): Promise<void> {
	client.onMessage(printJsonLine);
	await requireSuccessAsync(client.request({ type: "attach", daemonSessionId }));
	await waitUntilInterrupted();
}

async function runRename(client: DaemonClient, args: string[], json: boolean): Promise<void> {
	const daemonSessionId = requireSessionId(args);
	const name = args.slice(1).join(" ").trim();
	if (!name) {
		throw new Error("Usage: daemon rename <session> <name>");
	}
	const response = await client.request({ type: "rename", daemonSessionId, name });
	const data = requireSuccess(response);
	if (json) {
		printJson(data);
		return;
	}

	if (isSessionSummary(data)) {
		console.log(`Renamed ${data.daemonSessionId} to ${data.sessionName ?? name}`);
		return;
	}
	printJson(data);
}

async function runPrompt(client: DaemonClient, args: string[]): Promise<void> {
	const daemonSessionId = requireSessionId(args);
	const message = args.slice(1).join(" ").trim();
	if (!message) {
		throw new Error("Usage: daemon prompt <session> <message>");
	}

	const finished = waitForSessionEnd(client, daemonSessionId);
	client.onMessage(printJsonLine);
	await requireSuccessAsync(client.request({ type: "attach", daemonSessionId }));
	await requireSuccessAsync(client.request({ type: "prompt", daemonSessionId, message }));
	await finished;
}

async function runMessageCommand(
	client: DaemonClient,
	type: "steer" | "follow_up",
	args: string[],
	json: boolean,
): Promise<void> {
	const daemonSessionId = requireSessionId(args);
	const message = args.slice(1).join(" ").trim();
	if (!message) {
		const command = type === "follow_up" ? "follow-up" : type;
		throw new Error(`Usage: daemon ${command} <session> <message>`);
	}
	await printResponseData(client, { type, daemonSessionId, message }, json);
}

async function printResponseData(
	client: DaemonClient,
	command: Parameters<DaemonClient["request"]>[0],
	json: boolean,
): Promise<void> {
	const response = await client.request(command);
	const data = requireSuccess(response);
	if (json || data !== undefined) {
		printJson(data ?? response);
		return;
	}
	console.log("ok");
}

function requireSessionId(args: string[]): string {
	const daemonSessionId = args[0];
	if (!daemonSessionId) {
		throw new Error("Missing daemon session id");
	}
	return daemonSessionId;
}

function requireSuccess(response: DaemonResponse): unknown {
	if (!response.success) {
		throw new Error(response.error);
	}
	return "data" in response ? response.data : undefined;
}

async function requireSuccessAsync(responsePromise: Promise<DaemonResponse>): Promise<unknown> {
	return requireSuccess(await responsePromise);
}

function waitForSessionEnd(client: DaemonClient, daemonSessionId: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = client.onMessage((message) => {
			if (message.type === "session_event" && message.daemonSessionId === daemonSessionId) {
				if (message.event.type === "agent_end") {
					unsubscribe();
					resolve();
				}
			} else if (message.type === "session_closed" && message.daemonSessionId === daemonSessionId) {
				unsubscribe();
				resolve();
			}
		});
	});
}

function waitUntilInterrupted(): Promise<void> {
	return new Promise((resolve) => {
		const onSigint = () => {
			process.off("SIGTERM", onSigterm);
			resolve();
		};
		const onSigterm = () => {
			process.off("SIGINT", onSigint);
			resolve();
		};
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);
	});
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

const printJsonLine: DaemonClientMessageListener = (value) => {
	console.log(JSON.stringify(value));
};

class DaemonAttachTerminal {
	private rl?: Interface;
	private isStreaming = false;
	private readonly prompt = chalk.green("prime-agent> ");

	constructor(
		private readonly client: DaemonClient,
		private readonly daemonSessionId: string,
	) {}

	async run(): Promise<void> {
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		this.rl.setPrompt(this.prompt);

		const unsubscribe = this.client.onMessage((message) => this.handleMessage(message));
		this.rl.on("line", (line) => {
			void this.handleInput(line).catch((error) => {
				this.writeLine(chalk.red(error instanceof Error ? error.message : String(error)));
			});
		});
		this.rl.on("SIGINT", () => {
			this.rl?.close();
		});

		try {
			await requireSuccessAsync(this.client.request({ type: "attach", daemonSessionId: this.daemonSessionId }));
			await new Promise<void>((resolve) => {
				this.rl?.once("close", resolve);
			});
		} finally {
			unsubscribe();
			this.rl?.removeAllListeners();
			this.rl = undefined;
			await this.client.request({ type: "detach", daemonSessionId: this.daemonSessionId }).catch(() => undefined);
			process.stdin.pause();
			process.stdout.write(`${chalk.dim("Detached.")}\n`);
		}
	}

	private async handleInput(line: string): Promise<void> {
		const input = line.trim();
		if (!input) {
			this.rl?.prompt();
			return;
		}

		if (input === "/quit" || input === "/exit" || input === "/detach") {
			this.rl?.close();
			return;
		}

		if (input === "/help") {
			this.printHelp();
			this.rl?.prompt();
			return;
		}

		if (input === "/abort") {
			requireSuccess(await this.client.request({ type: "abort", daemonSessionId: this.daemonSessionId }));
			this.writeLine(chalk.dim("Abort requested."));
			return;
		}

		if (input === "/state") {
			const response = await this.client.request({ type: "get_state", daemonSessionId: this.daemonSessionId });
			this.writeLine(JSON.stringify(requireSuccess(response), null, 2));
			return;
		}

		if (input === "/messages") {
			const response = await this.client.request({ type: "get_messages", daemonSessionId: this.daemonSessionId });
			const data = requireSuccess(response);
			if (isMessagesData(data)) {
				this.writeLine(chalk.bold("Transcript"));
				this.printTranscript(data.messages);
			} else {
				this.writeLine(JSON.stringify(data, null, 2));
			}
			return;
		}

		if (this.isStreaming) {
			requireSuccess(
				await this.client.request({ type: "follow_up", daemonSessionId: this.daemonSessionId, message: input }),
			);
			this.writeLine(chalk.dim("Queued follow-up."));
			return;
		}

		requireSuccess(
			await this.client.request({ type: "prompt", daemonSessionId: this.daemonSessionId, message: input }),
		);
	}

	private handleMessage(message: DaemonOutbound): void {
		switch (message.type) {
			case "daemon_hello":
				return;
			case "session_attached":
				this.isStreaming = message.state.isStreaming;
				this.writeLine(chalk.bold(`Attached to ${message.state.sessionName ?? message.daemonSessionId}`));
				if (message.state.model) {
					this.writeLine(chalk.dim(`Model: ${message.state.model.provider}/${message.state.model.id}`));
				}
				if (message.state.sessionFile) {
					this.writeLine(chalk.dim(`Session: ${message.state.sessionFile}`));
				}
				this.printHelp();
				if (message.messages.length > 0) {
					this.writeLine(chalk.bold("Transcript"));
					this.printTranscript(message.messages);
				}
				this.rl?.prompt();
				return;
			case "session_event":
				this.handleSessionEvent(message.event);
				return;
			case "session_detached":
				return;
			case "session_closed":
				this.writeLine(chalk.yellow(`Session closed: ${message.reason}`));
				this.rl?.close();
				return;
			case "extension_ui_request":
				this.writeLine(chalk.dim(`Extension UI request: ${message.method}`));
				return;
			case "extension_error":
				this.writeLine(chalk.red(`Extension error (${message.extensionPath}, ${message.event}): ${message.error}`));
				return;
			case "response":
				if (!message.success) {
					this.writeLine(chalk.red(message.error));
				}
				return;
		}
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.isStreaming = true;
				this.writeLine(chalk.dim("Agent started."));
				return;
			case "agent_end":
				this.isStreaming = false;
				this.writeLine(chalk.dim("Agent idle."));
				return;
			case "message_end":
				this.printMessage(event.message);
				return;
			case "message_update":
				if (event.assistantMessageEvent.type === "toolcall_end") {
					this.writeLine(chalk.dim(`Tool call: ${event.assistantMessageEvent.toolCall.name}`));
				}
				return;
			case "tool_execution_start":
				this.writeLine(chalk.dim(`Tool started: ${event.toolName}`));
				return;
			case "tool_execution_end":
				this.writeLine(chalk.dim(`Tool ${event.isError ? "failed" : "finished"}: ${event.toolName}`));
				return;
			case "queue_update":
				if (event.steering.length > 0 || event.followUp.length > 0) {
					this.writeLine(
						chalk.dim(`Queued: ${event.steering.length} steering, ${event.followUp.length} follow-up`),
					);
				}
				return;
			case "session_info_changed":
				this.writeLine(chalk.dim(`Session name: ${event.name ?? "(unnamed)"}`));
				return;
			case "thinking_level_changed":
				this.writeLine(chalk.dim(`Thinking: ${event.level}`));
				return;
			case "compaction_start":
				this.writeLine(chalk.dim(`Compaction started: ${event.reason}`));
				return;
			case "compaction_end":
				this.writeLine(chalk.dim(`Compaction ${event.aborted ? "aborted" : "finished"}: ${event.reason}`));
				return;
			case "auto_retry_start":
				this.writeLine(chalk.dim(`Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`));
				return;
			case "auto_retry_end":
				this.writeLine(chalk.dim(event.success ? "Retry succeeded." : `Retry failed: ${event.finalError ?? ""}`));
				return;
			case "rlm_child_update":
				this.writeLine(chalk.dim(`Subagent ${event.child.label}: ${event.child.status}`));
				return;
			case "goal_update":
				this.writeLine(chalk.dim(`Goal: ${event.goal.status}`));
				return;
			case "turn_start":
			case "turn_end":
			case "message_start":
			case "tool_execution_update":
				return;
		}
	}

	private printTranscript(messages: AgentMessage[]): void {
		for (const message of messages) {
			this.printMessage(message);
		}
	}

	private printMessage(message: AgentMessage): void {
		const role = getMessageRole(message);
		const body = getMessageText(message).trim();
		const label = formatRole(role);
		this.writeLine(body ? `${label}\n${indent(body)}` : `${label} ${chalk.dim("[no text content]")}`);
	}

	private printHelp(): void {
		this.writeLine(chalk.dim("Type a message and press Enter. Commands: /help /state /messages /abort /detach"));
	}

	private writeLine(text: string): void {
		if (this.rl && process.stdout.isTTY) {
			clearLine(process.stdout, 0);
			cursorTo(process.stdout, 0);
		}
		process.stdout.write(`${text}\n`);
		this.rl?.prompt(true);
	}
}

function isMessagesData(value: unknown): value is { messages: AgentMessage[] } {
	if (!value || typeof value !== "object") {
		return false;
	}
	return Array.isArray((value as { messages?: unknown }).messages);
}

function getMessageRole(message: AgentMessage): string {
	if (!message || typeof message !== "object" || !("role" in message) || typeof message.role !== "string") {
		return "message";
	}
	return message.role;
}

function getMessageText(message: AgentMessage): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return JSON.stringify(message);
	}
	return formatContent((message as { content: unknown }).content);
}

function formatContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(formatContentBlock)
			.filter((text) => text.length > 0)
			.join("\n");
	}
	if (content === undefined || content === null) {
		return "";
	}
	return JSON.stringify(content);
}

function formatContentBlock(block: unknown): string {
	if (!block || typeof block !== "object" || !("type" in block) || typeof block.type !== "string") {
		return JSON.stringify(block);
	}

	switch (block.type) {
		case "text":
			return getStringProperty(block, "text");
		case "thinking": {
			const thinking = getStringProperty(block, "thinking");
			return thinking ? `[thinking]\n${thinking}` : "[thinking]";
		}
		case "image": {
			const mimeType = getStringProperty(block, "mimeType");
			return mimeType ? `[image: ${mimeType}]` : "[image]";
		}
		case "toolCall": {
			const name = getStringProperty(block, "name");
			const args = getUnknownProperty(block, "arguments");
			const argsText = args === undefined ? "" : ` ${JSON.stringify(args)}`;
			return `[tool call: ${name || "unknown"}${argsText}]`;
		}
		default:
			return JSON.stringify(block);
	}
}

function getStringProperty(value: object, key: string): string {
	const record = value as Record<string, unknown>;
	const property = record[key];
	return typeof property === "string" ? property : "";
}

function getUnknownProperty(value: object, key: string): unknown {
	return (value as Record<string, unknown>)[key];
}

function formatRole(role: string): string {
	switch (role) {
		case "user":
			return chalk.blue.bold("user:");
		case "assistant":
			return chalk.green.bold("assistant:");
		case "toolResult":
			return chalk.magenta.bold("tool:");
		default:
			return chalk.bold(`${role}:`);
	}
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function printTable<T extends Record<string, string>>(columns: Array<keyof T>, rows: T[]): void {
	const widths = columns.map((column) =>
		Math.max(String(column).length, ...rows.map((row) => String(row[column]).length)),
	);
	console.log(columns.map((column, index) => String(column).padEnd(widths[index])).join("  "));
	for (const row of rows) {
		console.log(columns.map((column, index) => String(row[column]).padEnd(widths[index])).join("  "));
	}
}

function isSessionListData(value: unknown): value is { sessions: DaemonSessionSummary[] } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const sessions = (value as { sessions?: unknown }).sessions;
	return Array.isArray(sessions) && sessions.every(isSessionSummary);
}

function isSessionSummary(value: unknown): value is DaemonSessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<DaemonSessionSummary>;
	return (
		typeof candidate.daemonSessionId === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.isStreaming === "boolean" &&
		typeof candidate.isCompacting === "boolean" &&
		typeof candidate.attachedClients === "number" &&
		typeof candidate.messageCount === "number"
	);
}

function printDaemonHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} daemon [options] [session name]
  ${APP_NAME} daemon --name <name> [agent options]
  ${APP_NAME} daemon [--socket <path>] <command> [args...]
  ${APP_NAME} daemon help

${chalk.bold("Commands:")}
  help                          Show daemon help
  start                         Start the background daemon and return
  list                          List live daemon-owned sessions
  list-saved                    List saved sessions for the current project
  create [name]                 Create a new live daemon session
  attach <session>              Attach an interactive terminal to a live session
  detach [session]              Detach this client from one session or all sessions
  prompt <session> <message>    Send a prompt, stream events, and exit when idle
  steer <session> <message>     Queue a steering message
  follow-up <session> <message> Queue a follow-up message
  rename <session> <name>       Rename a live session
  kill <session>                Kill a live session
  state <session>               Print session state as JSON
  messages <session>            Print messages as JSON
  stats <session>               Print session stats as JSON
  commands <session>            Print available commands as JSON
  shutdown                      Stop the daemon

${chalk.bold("Options:")}
  --socket <path>               Socket path (default: ${defaultDaemonSocketPath()})
  --name <name>                 Name for the new session created by bare daemon
  --foreground, --no-detach     Keep daemon attached to this terminal for debugging
  --json                        Print raw JSON for commands with formatted output; attach streams raw protocol JSON

${chalk.bold("Examples:")}
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock --model openai/gpt-4o-mini
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock --name scratch --model openai/gpt-4o-mini
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock scratch
  ${APP_NAME} daemon start --socket /tmp/prime-agent.sock --model openai/gpt-4o-mini
  ${APP_NAME} daemon start --foreground --socket /tmp/prime-agent.sock --offline
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock list
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock create scratch
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock prompt <session> "Say hello"
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock attach <session>
  ${APP_NAME} daemon --socket /tmp/prime-agent.sock shutdown
`);
}
