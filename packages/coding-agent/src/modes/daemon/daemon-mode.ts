/**
 * Background daemon mode.
 *
 * The daemon owns live AgentSessionRuntime instances and exposes a small JSONL
 * protocol over a local socket. Clients can attach/detach from sessions without
 * disposing the underlying agent loop.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import type { SessionStats } from "../../core/agent-session.js";
import { mergeAgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import { type AgentSessionRuntime, createAgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { SessionManager } from "../../core/session-manager.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type { RpcSlashCommand } from "../rpc/rpc-types.js";
import { type ActiveSessionRecord, type DaemonSocketClient, stateForRecord } from "./active-session-record.js";
import { bindActiveSessionRecord } from "./daemon-extension-binding.js";
import {
	type DaemonCommand,
	type DaemonModeOptions,
	type DaemonOutbound,
	type DaemonResponse,
	failure,
	success,
} from "./daemon-protocol.js";
import { buildDaemonSessionList, type InactiveDaemonSessionStatus } from "./daemon-session-list.js";
import { cleanupDaemonSocketPath, defaultDaemonSocketPath, prepareDaemonSocketPath } from "./daemon-socket.js";

export type {
	ActiveSessionState,
	DaemonCommand,
	DaemonModeOptions,
	DaemonOutbound,
	DaemonResponse,
} from "./daemon-protocol.js";
export type { DaemonSessionListEntry, DaemonSessionStatus } from "./daemon-session-list.js";
export { defaultDaemonSocketPath } from "./daemon-socket.js";

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
	private readonly clients = new Set<DaemonSocketClient>();
	private readonly sessions = new Map<string, ActiveSessionRecord>();
	private readonly inactiveSessionStatuses = new Map<string, InactiveDaemonSessionStatus>();
	private readonly signalCleanupHandlers: Array<() => void> = [];

	constructor(
		private readonly socketPath: string,
		private readonly options: DaemonModeOptions,
	) {}

	async start(): Promise<void> {
		await prepareDaemonSocketPath(this.socketPath);

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

	private cleanupSocketPath(): void {
		if (!this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		cleanupDaemonSocketPath(this.socketPath);
	}

	private async addRuntime(runtime: AgentSessionRuntime, name?: string): Promise<ActiveSessionRecord> {
		const record: ActiveSessionRecord = {
			activeSessionId: randomUUID().slice(0, 8),
			runtime,
			clients: new Set(),
		};
		await bindActiveSessionRecord(record, {
			broadcast: (targetRecord, message) => this.broadcastToRecord(targetRecord, message),
			shutdown: () => {
				void this.shutdown(0);
			},
		});
		this.sessions.set(record.activeSessionId, record);
		const sessionFile = record.runtime.session.sessionFile;
		if (sessionFile) {
			this.inactiveSessionStatuses.delete(resolve(sessionFile));
		}
		if (name) {
			record.runtime.session.setSessionName(name);
		}
		return record;
	}

	private async createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionRecord> {
		const config = mergeAgentSessionRuntimeConfig(this.options.defaultSessionConfig, command.config);
		if (!config.cwd) {
			throw new Error("Active session config is missing cwd");
		}
		if (!config.agentDir) {
			throw new Error("Active session config is missing agentDir");
		}

		const cwd = resolve(config.cwd);
		const cwdOverride = command.config?.cwd ? resolve(command.config.cwd) : undefined;
		const sessionManager = command.sessionPath
			? SessionManager.open(command.sessionPath, config.sessionDir, cwdOverride)
			: command.continueRecent
				? SessionManager.continueRecent(cwd, config.sessionDir)
				: SessionManager.create(cwd, config.sessionDir);
		const runtime = await createAgentSessionRuntime(this.options.createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: config.agentDir,
			sessionManager,
			sessionConfig: config,
		});
		return this.addRuntime(runtime, command.name);
	}

	private getRecord(id: string): ActiveSessionRecord {
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
		throw new Error(`Unknown active session: ${id}`);
	}

	private handleConnection(socket: Socket): void {
		const client: DaemonSocketClient = {
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

	private async handleLine(client: DaemonSocketClient, line: string): Promise<void> {
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

	private async handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
	): Promise<DaemonResponse | undefined> {
		switch (command.type) {
			case "list": {
				const activeRecords = Array.from(this.sessions.values());
				if (!command.all) {
					return success(command.id, "list", {
						sessions: buildDaemonSessionList(activeRecords, [], this.inactiveSessionStatuses),
					});
				}
				const defaultConfig = this.options.defaultSessionConfig;
				if (!defaultConfig.cwd) {
					throw new Error("Active session config is missing cwd");
				}
				const cwd = resolve(command.cwd ?? defaultConfig.cwd);
				const savedSessions = await SessionManager.list(cwd, command.sessionDir ?? defaultConfig.sessionDir);
				return success(command.id, "list", {
					sessions: buildDaemonSessionList(activeRecords, savedSessions, this.inactiveSessionStatuses),
				});
			}

			case "create": {
				const record = await this.createRuntime(command);
				return success(command.id, "create", stateForRecord(record));
			}

			case "attach": {
				const record = this.getRecord(command.activeSessionId);
				record.clients.add(client);
				client.attachedActiveSessionIds.add(record.activeSessionId);
				this.write(client, {
					type: "session_attached",
					activeSessionId: record.activeSessionId,
					state: stateForRecord(record),
					messages: record.runtime.session.messages,
				});
				return success(command.id, "attach", stateForRecord(record));
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
				return success(command.id, "rename", stateForRecord(record));
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
				return success(command.id, "get_state", stateForRecord(record));
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

	private detachClientFromRecord(client: DaemonSocketClient, record: ActiveSessionRecord): void {
		record.clients.delete(client);
		client.attachedActiveSessionIds.delete(record.activeSessionId);
		this.write(client, { type: "session_detached", activeSessionId: record.activeSessionId });
	}

	private detachClient(client: DaemonSocketClient): void {
		for (const activeSessionId of [...client.attachedActiveSessionIds]) {
			const record = this.sessions.get(activeSessionId);
			if (record) {
				this.detachClientFromRecord(client, record);
			}
		}
	}

	private async killRecord(record: ActiveSessionRecord, reason: "killed" | "shutdown"): Promise<void> {
		record.unsubscribe?.();
		await record.runtime.dispose();
		this.sessions.delete(record.activeSessionId);
		if (reason === "killed") {
			const sessionFile = record.runtime.session.sessionFile;
			if (sessionFile) {
				this.inactiveSessionStatuses.set(resolve(sessionFile), "killed");
			}
		}
		this.broadcastToRecord(record, { type: "session_closed", activeSessionId: record.activeSessionId, reason });
		for (const client of record.clients) {
			client.attachedActiveSessionIds.delete(record.activeSessionId);
		}
		record.clients.clear();
	}

	private broadcastToRecord(record: ActiveSessionRecord, message: DaemonOutbound): void {
		for (const client of record.clients) {
			this.write(client, message);
		}
	}

	private write(client: DaemonSocketClient, message: DaemonOutbound): void {
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
