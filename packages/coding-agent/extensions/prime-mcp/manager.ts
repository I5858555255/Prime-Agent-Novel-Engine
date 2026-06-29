/**
 * Connection manager for configured MCP servers.
 *
 * Connections are established lazily on first use, cached, torn down after an
 * idle period, and transparently re-established once if a call fails on a dead
 * transport. The actual transport wiring lives in `connector.ts` and is
 * injectable so tests can run against an in-memory server.
 */

import { isHttpServer, type McpConfig, type McpServerConfig } from "./config.js";

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
	content: unknown;
	isError: boolean;
	structuredContent?: Record<string, unknown>;
}

/** Minimal client surface the manager depends on. */
export interface McpClientLike {
	listTools(signal?: AbortSignal): Promise<McpToolInfo[]>;
	callTool(tool: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<McpCallResult>;
	close(): Promise<void>;
}

export type McpConnector = (name: string, config: McpServerConfig, signal?: AbortSignal) => Promise<McpClientLike>;

export type ServerState = "disconnected" | "connected" | "error";

export interface ServerStatus {
	name: string;
	transport: "stdio" | "http";
	state: ServerState;
	toolCount?: number;
	error?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface Connection {
	client: McpClientLike;
	tools?: McpToolInfo[];
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface ManagerOptions {
	connector: McpConnector;
	idleTimeoutMs?: number;
	logger?: (message: string) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}

const CONNECTION_ERROR =
	/\b(not connected|connection (closed|reset|refused|lost)|transport (closed|error)|socket hang up|econnreset|econnrefused|epipe|premature close|stream is not readable|terminated)\b/i;

/**
 * Whether an error looks like a dead transport rather than a tool-level failure.
 * Only these are retried, so a stateful tool that errored after doing work is
 * never silently re-invoked.
 */
function isConnectionError(error: unknown): boolean {
	return error instanceof Error && CONNECTION_ERROR.test(error.message);
}

export class McpManager {
	private readonly connections = new Map<string, Connection>();
	private readonly connecting = new Map<string, Promise<Connection>>();
	private readonly states = new Map<string, { state: ServerState; error?: string }>();
	private config: McpConfig;
	private idleTimeoutMs: number;

	constructor(
		config: McpConfig,
		private readonly options: ManagerOptions,
	) {
		this.config = config;
		this.idleTimeoutMs = options.idleTimeoutMs ?? config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	}

	/** Replace the server configuration, dropping any existing connections. */
	async setConfig(config: McpConfig): Promise<void> {
		await this.disconnectAll();
		this.config = config;
		this.idleTimeoutMs = this.options.idleTimeoutMs ?? config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	}

	serverNames(): string[] {
		return Object.keys(this.config.mcpServers);
	}

	hasServer(name: string): boolean {
		return name in this.config.mcpServers;
	}

	getStatus(name: string): ServerStatus | undefined {
		const serverConfig = this.config.mcpServers[name];
		if (!serverConfig) return undefined;
		const tracked = this.states.get(name);
		return {
			name,
			transport: isHttpServer(serverConfig) ? "http" : "stdio",
			state: tracked?.state ?? "disconnected",
			toolCount: this.connections.get(name)?.tools?.length,
			error: tracked?.error,
		};
	}

	listStatuses(): ServerStatus[] {
		return this.serverNames().map((name) => this.getStatus(name)!);
	}

	private requireServerConfig(name: string): McpServerConfig {
		const serverConfig = this.config.mcpServers[name];
		if (!serverConfig) throw new Error(`Unknown MCP server: "${name}"`);
		return serverConfig;
	}

	private clearIdle(name: string): void {
		const connection = this.connections.get(name);
		if (connection?.idleTimer) {
			clearTimeout(connection.idleTimer);
			connection.idleTimer = undefined;
		}
	}

	private scheduleIdleDisconnect(name: string): void {
		const connection = this.connections.get(name);
		if (!connection) return;
		if (connection.idleTimer) clearTimeout(connection.idleTimer);
		if (this.idleTimeoutMs <= 0) return;
		connection.idleTimer = setTimeout(() => {
			void this.disconnect(name);
		}, this.idleTimeoutMs);
		// Never let an idle MCP connection keep the process alive.
		connection.idleTimer.unref?.();
	}

	private async connect(name: string, signal?: AbortSignal): Promise<Connection> {
		const existing = this.connecting.get(name);
		if (existing) return existing;

		const serverConfig = this.requireServerConfig(name);
		const attempt = (async (): Promise<Connection> => {
			try {
				const client = await this.options.connector(name, serverConfig, signal);
				const connection: Connection = { client };
				this.connections.set(name, connection);
				this.states.set(name, { state: "connected" });
				return connection;
			} catch (error) {
				this.states.set(name, { state: "error", error: errorMessage(error) });
				throw error;
			} finally {
				this.connecting.delete(name);
			}
		})();

		this.connecting.set(name, attempt);
		return attempt;
	}

	private async ensureConnected(name: string, signal?: AbortSignal): Promise<Connection> {
		const connection = this.connections.get(name);
		if (connection) {
			// An operation is about to run; disarm idle disconnect until it finishes.
			this.clearIdle(name);
			return connection;
		}
		return this.connect(name, signal);
	}

	async listTools(name: string, signal?: AbortSignal): Promise<McpToolInfo[]> {
		const connection = await this.ensureConnected(name, signal);
		try {
			if (!connection.tools) {
				connection.tools = await connection.client.listTools(signal);
			}
			return connection.tools;
		} finally {
			this.scheduleIdleDisconnect(name);
		}
	}

	async describeTool(name: string, tool: string, signal?: AbortSignal): Promise<McpToolInfo> {
		const tools = await this.listTools(name, signal);
		const found = tools.find((t) => t.name === tool);
		if (!found) {
			throw new Error(`MCP server "${name}" has no tool "${tool}"`);
		}
		return found;
	}

	async callTool(
		name: string,
		tool: string,
		args: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<McpCallResult> {
		this.requireServerConfig(name);
		const connection = await this.ensureConnected(name, signal);
		try {
			return await connection.client.callTool(tool, args, signal);
		} catch (error) {
			// Only retry when the transport looks dead; never re-invoke a tool that
			// failed after the server may have already acted on it.
			if (isAbort(error) || signal?.aborted || !isConnectionError(error)) throw error;
			this.options.logger?.(`MCP server "${name}" call failed, reconnecting: ${errorMessage(error)}`);
			await this.disconnect(name);
			const reconnected = await this.ensureConnected(name, signal);
			return await reconnected.client.callTool(tool, args, signal);
		} finally {
			this.scheduleIdleDisconnect(name);
		}
	}

	async reconnect(name: string, signal?: AbortSignal): Promise<void> {
		this.requireServerConfig(name);
		await this.disconnect(name);
		await this.ensureConnected(name, signal);
		this.scheduleIdleDisconnect(name);
	}

	async disconnect(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection) return;
		this.connections.delete(name);
		if (connection.idleTimer) clearTimeout(connection.idleTimer);
		this.states.set(name, { state: "disconnected" });
		try {
			await connection.client.close();
		} catch (error) {
			this.options.logger?.(`Error closing MCP server "${name}": ${errorMessage(error)}`);
		}
	}

	async disconnectAll(): Promise<void> {
		await Promise.all([...this.connections.keys()].map((name) => this.disconnect(name)));
	}
}
