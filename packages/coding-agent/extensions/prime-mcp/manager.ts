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
	/** MCP allows any JSON value here, including scalars. */
	structuredContent?: unknown;
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
	/** Number of operations currently running against this connection. */
	active: number;
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
	private readonly connecting = new Map<string, { promise: Promise<Connection>; controller: AbortController }>();
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
		// An operation is still in flight; it will reschedule when it finishes.
		if (connection.active > 0) return;
		if (this.idleTimeoutMs <= 0) return;
		connection.idleTimer = setTimeout(() => {
			void this.disconnect(name);
		}, this.idleTimeoutMs);
		// Never let an idle MCP connection keep the process alive.
		connection.idleTimer.unref?.();
	}

	/**
	 * Connect to a server, deduping concurrent attempts. The attempt has its own
	 * AbortController (not any caller's signal) so one caller aborting cannot kill
	 * a connection others are waiting on, while `disconnect` can still cancel a
	 * hung connect promptly instead of blocking on the connector's own timeout.
	 */
	private connect(name: string): Promise<Connection> {
		const existing = this.connecting.get(name);
		if (existing) return existing.promise;

		const serverConfig = this.requireServerConfig(name);
		const controller = new AbortController();
		const promise = (async (): Promise<Connection> => {
			try {
				const client = await this.options.connector(name, serverConfig, controller.signal);
				const connection: Connection = { client, active: 0 };
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

		this.connecting.set(name, { promise, controller });
		return promise;
	}

	/**
	 * Begin an operation: ensure a live connection and disarm idle disconnect so
	 * the timer can never close a connection out from under an in-flight call.
	 */
	private async begin(name: string): Promise<Connection> {
		const connection = this.connections.get(name) ?? (await this.connect(name));
		connection.active += 1;
		this.clearIdle(name);
		return connection;
	}

	/**
	 * End an operation against a specific connection. Decrement that instance's
	 * counter (not whatever is current under `name`, which may have been replaced
	 * by a reconnect) and rearm idle disconnect only for the live, idle one.
	 */
	private end(name: string, connection: Connection): void {
		connection.active = Math.max(0, connection.active - 1);
		if (this.connections.get(name) === connection && connection.active <= 0) {
			this.scheduleIdleDisconnect(name);
		}
	}

	/**
	 * Run an operation against a connected client, retrying once on a dead
	 * transport. Only transport-level failures are retried; tool-level errors and
	 * aborts propagate untouched so a tool that already acted is never re-invoked.
	 */
	private async withConnection<T>(
		name: string,
		signal: AbortSignal | undefined,
		op: (connection: Connection) => Promise<T>,
	): Promise<T> {
		this.requireServerConfig(name);
		let connection = await this.begin(name);
		try {
			try {
				return await op(connection);
			} catch (error) {
				if (isAbort(error) || signal?.aborted || !isConnectionError(error)) throw error;
				this.options.logger?.(`MCP server "${name}" operation failed, reconnecting: ${errorMessage(error)}`);
			}
			this.end(name, connection);
			await this.dropConnection(name, connection);
			connection = await this.begin(name);
			return await op(connection);
		} finally {
			this.end(name, connection);
		}
	}

	async listTools(name: string, signal?: AbortSignal): Promise<McpToolInfo[]> {
		return this.withConnection(name, signal, async (connection) => {
			if (!connection.tools) {
				connection.tools = await connection.client.listTools(signal);
			}
			return connection.tools;
		});
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
		return this.withConnection(name, signal, (connection) => connection.client.callTool(tool, args, signal));
	}

	async reconnect(name: string, _signal?: AbortSignal): Promise<void> {
		this.requireServerConfig(name);
		await this.disconnect(name);
		const connection = await this.begin(name);
		this.end(name, connection);
	}

	/**
	 * Close one connection instance, evicting it from the map only if it is still
	 * the current one. Used by the retry path so a failing call never closes a
	 * sibling call's freshly reconnected client.
	 */
	private async dropConnection(name: string, connection: Connection): Promise<void> {
		if (this.connections.get(name) === connection) {
			this.connections.delete(name);
			this.states.set(name, { state: "disconnected" });
		}
		if (connection.idleTimer) clearTimeout(connection.idleTimer);
		try {
			await connection.client.close();
		} catch (error) {
			this.options.logger?.(`Error closing MCP server "${name}": ${errorMessage(error)}`);
		}
	}

	async disconnect(name: string): Promise<void> {
		// A connect may still be in flight; abort it (so a hung connector doesn't
		// block shutdown) and wait so we never leak a client that resolves after
		// we thought the server was gone.
		const pending = this.connecting.get(name);
		if (pending) {
			pending.controller.abort();
			try {
				await pending.promise;
			} catch {
				// Connection failed or was aborted; nothing to close.
			}
		}
		const connection = this.connections.get(name);
		if (!connection) return;
		await this.dropConnection(name, connection);
	}

	async disconnectAll(): Promise<void> {
		const names = new Set([...this.connections.keys(), ...this.connecting.keys()]);
		await Promise.all([...names].map((name) => this.disconnect(name)));
	}
}
