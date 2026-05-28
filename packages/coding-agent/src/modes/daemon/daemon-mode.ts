/**
 * Proof-of-concept background daemon mode.
 *
 * The daemon owns live AgentSessionRuntime instances and exposes a small JSONL
 * protocol over a local socket. Clients can attach/detach from sessions without
 * disposing the underlying agent loop.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, SessionStats } from "../../core/agent-session.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.js";
import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.js";
import { type SessionInfo, SessionManager } from "../../core/session-manager.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type { RpcSlashCommand } from "../rpc/rpc-types.js";

export interface DaemonModeOptions {
	socketPath?: string;
	cwd: string;
	agentDir: string;
	sessionDir?: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
}

export interface DaemonSessionSummary {
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	isStreaming: boolean;
	isCompacting: boolean;
	attachedClients: number;
	messageCount: number;
}

export interface DaemonSessionState {
	model?: Model<Api>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	pendingMessageCount: number;
	streamingMessage?: AgentMessage;
}

export type DaemonCommand =
	| { id?: string; type: "list" }
	| { id?: string; type: "list_saved"; cwd?: string; sessionDir?: string }
	| {
			id?: string;
			type: "create";
			cwd?: string;
			sessionDir?: string;
			sessionPath?: string;
			continueRecent?: boolean;
			name?: string;
	  }
	| { id?: string; type: "attach"; activeSessionId: string }
	| { id?: string; type: "detach"; activeSessionId?: string }
	| { id?: string; type: "kill"; activeSessionId: string }
	| { id?: string; type: "rename"; activeSessionId: string; name: string }
	| {
			id?: string;
			type: "prompt";
			activeSessionId: string;
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id?: string; type: "steer"; activeSessionId: string; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; activeSessionId: string; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort"; activeSessionId: string }
	| { id?: string; type: "get_state"; activeSessionId: string }
	| { id?: string; type: "get_messages"; activeSessionId: string }
	| { id?: string; type: "get_session_stats"; activeSessionId: string }
	| { id?: string; type: "get_commands"; activeSessionId: string }
	| { id?: string; type: "shutdown" };

type DaemonCommandName = DaemonCommand["type"];

export type DaemonResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export type DaemonOutbound =
	| DaemonResponse
	| { type: "daemon_hello"; socketPath: string }
	| { type: "session_event"; activeSessionId: string; event: AgentSessionEvent }
	| { type: "session_attached"; activeSessionId: string; state: DaemonSessionState; messages: AgentMessage[] }
	| { type: "session_detached"; activeSessionId: string }
	| { type: "session_closed"; activeSessionId: string; reason: "killed" | "shutdown" }
	| {
			type: "extension_ui_request";
			activeSessionId: string;
			method: string;
			payload: Record<string, unknown>;
	  }
	| { type: "extension_error"; activeSessionId: string; extensionPath: string; event: string; error: string };

interface DaemonClient {
	id: string;
	socket: Socket;
	attachedActiveSessionIds: Set<string>;
	detachInput: () => void;
}

interface DaemonSessionRecord {
	activeSessionId: string;
	runtime: AgentSessionRuntime;
	clients: Set<DaemonClient>;
	unsubscribe?: () => void;
}

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-${process.pid}`;
	}
	return join(tmpdir(), "prime-agent-daemon.sock");
}

function stateForSession(session: AgentSession): DaemonSessionState {
	return {
		model: session.model as Model<Api> | undefined,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		streamingMessage: session.state.streamingMessage,
	};
}

function summaryForRecord(record: DaemonSessionRecord): DaemonSessionSummary {
	const session = record.runtime.session;
	return {
		activeSessionId: record.activeSessionId,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		cwd: session.sessionManager.getCwd(),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		attachedClients: record.clients.size,
		messageCount: session.messages.length,
	};
}

function success(id: string | undefined, command: DaemonCommandName, data?: unknown): DaemonResponse {
	return data === undefined
		? { id, type: "response", command, success: true }
		: { id, type: "response", command, success: true, data };
}

function failure(id: string | undefined, command: string, error: unknown): DaemonResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (canConnect: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};

		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

export async function runDaemonMode(initialRuntime: AgentSessionRuntime, options: DaemonModeOptions): Promise<never> {
	const socketPath = options.socketPath ?? defaultDaemonSocketPath();
	// main() creates a runtime before dispatching modes. Daemon mode should not
	// expose that bootstrap runtime as a user session; live sessions are created
	// explicitly through the daemon protocol.
	await initialRuntime.dispose();
	const daemon = new AgentDaemon(socketPath, options);
	await daemon.start();
	return new Promise(() => {});
}

class AgentDaemon {
	private server?: Server;
	private shuttingDown = false;
	private ownsSocketPath = false;
	private readonly clients = new Set<DaemonClient>();
	private readonly sessions = new Map<string, DaemonSessionRecord>();
	private readonly signalCleanupHandlers: Array<() => void> = [];

	constructor(
		private readonly socketPath: string,
		private readonly options: DaemonModeOptions,
	) {}

	async start(): Promise<void> {
		await this.prepareSocketPath();

		this.server = createServer((socket) => this.handleConnection(socket));

		try {
			await new Promise<void>((resolveListen, rejectListen) => {
				const onError = (error: Error) => {
					this.server?.off("listening", onListening);
					rejectListen(error);
				};
				const onListening = () => {
					this.server?.off("error", onError);
					if (process.platform !== "win32") {
						this.ownsSocketPath = true;
					}
					resolveListen();
				};
				this.server?.once("error", onError);
				this.server?.once("listening", onListening);
				this.server?.listen(this.socketPath);
			});
		} catch (error) {
			this.cleanupSocketPath();
			throw error;
		}

		this.registerSignalHandlers();
		console.error(`Prime Agent daemon listening on ${this.socketPath}`);
	}

	private async prepareSocketPath(): Promise<void> {
		if (process.platform === "win32" || !existsSync(this.socketPath)) {
			return;
		}

		const stat = lstatSync(this.socketPath);
		if (!stat.isSocket()) {
			throw new Error(`Daemon socket path exists and is not a socket: ${this.socketPath}`);
		}

		if (await canConnectToUnixSocket(this.socketPath)) {
			throw new Error(`Daemon socket already in use: ${this.socketPath}`);
		}

		unlinkSync(this.socketPath);
	}

	private cleanupSocketPath(): void {
		if (process.platform === "win32" || !this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		try {
			if (existsSync(this.socketPath)) {
				unlinkSync(this.socketPath);
			}
		} catch {
			// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
		}
	}

	private async addRuntime(runtime: AgentSessionRuntime, name?: string): Promise<DaemonSessionRecord> {
		const record: DaemonSessionRecord = {
			activeSessionId: randomUUID().slice(0, 8),
			runtime,
			clients: new Set(),
		};
		await this.bindRecord(record);
		this.sessions.set(record.activeSessionId, record);
		if (name) {
			record.runtime.session.setSessionName(name);
		}
		return record;
	}

	private async createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<DaemonSessionRecord> {
		const cwd = resolve(command.cwd ?? this.options.cwd);
		const sessionDir = command.sessionDir ?? this.options.sessionDir;
		const sessionManager = command.sessionPath
			? SessionManager.open(command.sessionPath, sessionDir)
			: command.continueRecent
				? SessionManager.continueRecent(cwd, sessionDir)
				: SessionManager.create(cwd, sessionDir);
		const runtime = await createAgentSessionRuntime(this.options.createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: this.options.agentDir,
			sessionManager,
		});
		return this.addRuntime(runtime, command.name);
	}

	private async bindRecord(record: DaemonSessionRecord): Promise<void> {
		const session = record.runtime.session;

		record.unsubscribe?.();
		record.unsubscribe = session.subscribe((event) => {
			this.broadcastToRecord(record, {
				type: "session_event",
				activeSessionId: record.activeSessionId,
				event,
			});
		});

		record.runtime.setRebindSession(async () => {
			await this.bindRecord(record);
		});

		await session.bindExtensions({
			uiContext: this.createExtensionUIContext(record),
			commandContextActions: this.createCommandContextActions(record),
			shutdownHandler: () => {
				void this.shutdown(0);
			},
			onError: (error) => {
				this.broadcastToRecord(record, {
					type: "extension_error",
					activeSessionId: record.activeSessionId,
					extensionPath: error.extensionPath,
					event: error.event,
					error: error.error,
				});
			},
		});
	}

	private createCommandContextActions(record: DaemonSessionRecord): ExtensionCommandContextActions {
		return {
			waitForIdle: () => record.runtime.session.agent.waitForIdle(),
			newSession: async (options) => record.runtime.newSession(options),
			fork: async (entryId, options) => {
				const result = await record.runtime.fork(entryId, options);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await record.runtime.session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, options) => record.runtime.switchSession(sessionPath, options),
			reload: async () => {
				await record.runtime.session.reload();
			},
		};
	}

	private createExtensionUIContext(record: DaemonSessionRecord): ExtensionUIContext {
		const emitUiRequest = (method: string, payload: Record<string, unknown>): void => {
			this.broadcastToRecord(record, {
				type: "extension_ui_request",
				activeSessionId: record.activeSessionId,
				method,
				payload,
			});
		};

		const dialogDefault = <T>(opts: ExtensionUIDialogOptions | undefined, fallback: T): Promise<T> => {
			if (opts?.signal?.aborted) {
				return Promise.resolve(fallback);
			}
			return new Promise((resolveDialog) => {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				const cleanup = () => {
					if (timeoutId) {
						clearTimeout(timeoutId);
					}
					opts?.signal?.removeEventListener("abort", onAbort);
				};
				const finish = () => {
					cleanup();
					resolveDialog(fallback);
				};
				const onAbort = () => finish();
				opts?.signal?.addEventListener("abort", onAbort, { once: true });
				timeoutId = setTimeout(finish, opts?.timeout ?? 0);
			});
		};

		return {
			select: (title, values, opts) => {
				emitUiRequest("select", { title, options: values, timeout: opts?.timeout });
				return dialogDefault(opts, undefined);
			},
			confirm: (title, message, opts) => {
				emitUiRequest("confirm", { title, message, timeout: opts?.timeout });
				return dialogDefault(opts, false);
			},
			input: (title, placeholder, opts) => {
				emitUiRequest("input", { title, placeholder, timeout: opts?.timeout });
				return dialogDefault(opts, undefined);
			},
			notify: (message, notifyType) => emitUiRequest("notify", { message, notifyType }),
			onTerminalInput: () => () => {},
			setStatus: (key, text) => emitUiRequest("setStatus", { statusKey: key, statusText: text }),
			setWorkingMessage: (message) => emitUiRequest("setWorkingMessage", { message }),
			setWorkingVisible: (visible) => emitUiRequest("setWorkingVisible", { visible }),
			setWorkingIndicator: (indicatorOptions?: WorkingIndicatorOptions) =>
				emitUiRequest("setWorkingIndicator", { options: indicatorOptions }),
			setHiddenThinkingLabel: (label) => emitUiRequest("setHiddenThinkingLabel", { label }),
			setWidget: (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => {
				if (content === undefined || Array.isArray(content)) {
					emitUiRequest("setWidget", {
						widgetKey: key,
						widgetLines: content,
						widgetPlacement: widgetOptions?.placement,
					});
				}
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => emitUiRequest("setTitle", { title }),
			async custom<T>(): Promise<T> {
				return undefined as T;
			},
			pasteToEditor: (text) => emitUiRequest("setEditorText", { text }),
			setEditorText: (text) => emitUiRequest("setEditorText", { text }),
			getEditorText: () => "",
			editor: (title, prefill) => {
				emitUiRequest("editor", { title, prefill });
				return Promise.resolve(undefined);
			},
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme(): Theme {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching is not supported in daemon mode" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	private getRecord(id: string): DaemonSessionRecord {
		const direct = this.sessions.get(id);
		if (direct) {
			return direct;
		}
		for (const record of this.sessions.values()) {
			const session = record.runtime.session;
			if (session.sessionId === id || session.sessionName === id) {
				return record;
			}
		}
		throw new Error(`Unknown daemon session: ${id}`);
	}

	private handleConnection(socket: Socket): void {
		const client: DaemonClient = {
			id: randomUUID().slice(0, 8),
			socket,
			attachedActiveSessionIds: new Set(),
			detachInput: () => {},
		};
		this.clients.add(client);
		this.write(client, { type: "daemon_hello", socketPath: this.socketPath });

		client.detachInput = attachJsonlLineReader(socket, (line) => {
			void this.handleLine(client, line);
		});

		const cleanup = () => {
			this.detachClient(client);
			client.detachInput();
			this.clients.delete(client);
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
	}

	private async handleLine(client: DaemonClient, line: string): Promise<void> {
		let command: DaemonCommand;
		try {
			command = JSON.parse(line) as DaemonCommand;
		} catch (error) {
			this.write(client, failure(undefined, "parse", error));
			return;
		}

		try {
			const response = await this.handleCommand(client, command);
			if (response) {
				this.write(client, response);
			}
		} catch (error) {
			this.write(client, failure(command.id, command.type, error));
		}
	}

	private async handleCommand(client: DaemonClient, command: DaemonCommand): Promise<DaemonResponse | undefined> {
		switch (command.type) {
			case "list":
				return success(command.id, "list", { sessions: Array.from(this.sessions.values()).map(summaryForRecord) });

			case "list_saved": {
				const cwd = resolve(command.cwd ?? this.options.cwd);
				const sessions: SessionInfo[] = await SessionManager.list(
					cwd,
					command.sessionDir ?? this.options.sessionDir,
				);
				return success(command.id, "list_saved", { sessions });
			}

			case "create": {
				const record = await this.createRuntime(command);
				return success(command.id, "create", summaryForRecord(record));
			}

			case "attach": {
				const record = this.getRecord(command.activeSessionId);
				record.clients.add(client);
				client.attachedActiveSessionIds.add(record.activeSessionId);
				this.write(client, {
					type: "session_attached",
					activeSessionId: record.activeSessionId,
					state: stateForSession(record.runtime.session),
					messages: record.runtime.session.messages,
				});
				return success(command.id, "attach", summaryForRecord(record));
			}

			case "detach": {
				if (command.activeSessionId) {
					const record = this.getRecord(command.activeSessionId);
					this.detachClientFromRecord(client, record);
				} else {
					this.detachClient(client);
				}
				return success(command.id, "detach");
			}

			case "kill": {
				const record = this.getRecord(command.activeSessionId);
				await this.killRecord(record, "killed");
				return success(command.id, "kill");
			}

			case "rename": {
				const record = this.getRecord(command.activeSessionId);
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				record.runtime.session.setSessionName(name);
				return success(command.id, "rename", summaryForRecord(record));
			}

			case "prompt": {
				const record = this.getRecord(command.activeSessionId);
				let preflightSucceeded = false;
				void record.runtime.session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								this.write(client, success(command.id, "prompt"));
							}
						},
					})
					.catch((error) => {
						if (preflightSucceeded) {
							this.broadcastToRecord(record, failure(command.id, "prompt", error));
						} else {
							this.write(client, failure(command.id, "prompt", error));
						}
					});
				return undefined;
			}

			case "steer": {
				const record = this.getRecord(command.activeSessionId);
				await record.runtime.session.steer(command.message, command.images);
				return success(command.id, "steer");
			}

			case "follow_up": {
				const record = this.getRecord(command.activeSessionId);
				await record.runtime.session.followUp(command.message, command.images);
				return success(command.id, "follow_up");
			}

			case "abort": {
				const record = this.getRecord(command.activeSessionId);
				await record.runtime.session.abort();
				return success(command.id, "abort");
			}

			case "get_state": {
				const record = this.getRecord(command.activeSessionId);
				return success(command.id, "get_state", stateForSession(record.runtime.session));
			}

			case "get_messages": {
				const record = this.getRecord(command.activeSessionId);
				return success(command.id, "get_messages", { messages: record.runtime.session.messages });
			}

			case "get_session_stats": {
				const record = this.getRecord(command.activeSessionId);
				const stats: SessionStats = record.runtime.session.getSessionStats();
				return success(command.id, "get_session_stats", stats);
			}

			case "get_commands": {
				const record = this.getRecord(command.activeSessionId);
				const session = record.runtime.session;
				const commands: RpcSlashCommand[] = [
					...session.extensionRunner.getRegisteredCommands().map((entry) => ({
						name: entry.invocationName,
						description: entry.description,
						source: "extension" as const,
						sourceInfo: entry.sourceInfo,
					})),
					...session.promptTemplates.map((entry) => ({
						name: entry.name,
						description: entry.description,
						source: "prompt" as const,
						sourceInfo: entry.sourceInfo,
					})),
					...session.resourceLoader.getSkills().skills.map((entry) => ({
						name: `skill:${entry.name}`,
						description: entry.description,
						source: "skill" as const,
						sourceInfo: entry.sourceInfo,
					})),
				];
				return success(command.id, "get_commands", { commands });
			}

			case "shutdown":
				void this.shutdown(0);
				return success(command.id, "shutdown");
		}
	}

	private detachClientFromRecord(client: DaemonClient, record: DaemonSessionRecord): void {
		record.clients.delete(client);
		client.attachedActiveSessionIds.delete(record.activeSessionId);
		this.write(client, { type: "session_detached", activeSessionId: record.activeSessionId });
	}

	private detachClient(client: DaemonClient): void {
		for (const activeSessionId of [...client.attachedActiveSessionIds]) {
			const record = this.sessions.get(activeSessionId);
			if (record) {
				this.detachClientFromRecord(client, record);
			}
		}
	}

	private async killRecord(record: DaemonSessionRecord, reason: "killed" | "shutdown"): Promise<void> {
		record.unsubscribe?.();
		await record.runtime.dispose();
		this.sessions.delete(record.activeSessionId);
		this.broadcastToRecord(record, { type: "session_closed", activeSessionId: record.activeSessionId, reason });
		for (const client of record.clients) {
			client.attachedActiveSessionIds.delete(record.activeSessionId);
		}
		record.clients.clear();
	}

	private broadcastToRecord(record: DaemonSessionRecord, message: DaemonOutbound): void {
		for (const client of record.clients) {
			this.write(client, message);
		}
	}

	private write(client: DaemonClient, message: DaemonOutbound): void {
		if (client.socket.destroyed) {
			return;
		}
		client.socket.write(serializeJsonLine(message));
	}

	private registerSignalHandlers(): void {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void this.shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const exitHandler = () => this.cleanupSocketPath();
		process.on("exit", exitHandler);
		this.signalCleanupHandlers.push(() => process.off("exit", exitHandler));
	}

	private async shutdown(exitCode: number): Promise<never> {
		if (this.shuttingDown) {
			process.exit(exitCode);
		}
		this.shuttingDown = true;

		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		for (const record of [...this.sessions.values()]) {
			await this.killRecord(record, "shutdown");
		}
		for (const client of this.clients) {
			client.detachInput();
			client.socket.end();
		}
		await new Promise<void>((resolveClose) => {
			if (!this.server) {
				resolveClose();
				return;
			}
			this.server.close(() => resolveClose());
		});
		this.cleanupSocketPath();
		process.exit(exitCode);
	}
}
