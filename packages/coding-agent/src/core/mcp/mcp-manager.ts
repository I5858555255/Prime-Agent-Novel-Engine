// Host side of MCP integrations. The protocol itself runs Python-side in the kernel; the host
// registers OAuth providers, gates integration skills by auth, owns stdio sidecars, and serves mcp.* host-requests.

import { resolve } from "node:path";
import {
	BUILTIN_MCP_CATALOG,
	createMcpOAuthProvider,
	getCatalogEntry,
	registerBuiltinMcpOAuthProviders,
} from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import { isRetryableStdioMcpError, isStdioMcpRequestNotSentError, StdioMcpClient } from "./stdio-mcp-client.js";

export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Effective workspace cwd used to resolve relative stdio server cwd values. */
	cwd?: string;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
}

/** A resolved integration: a catalog/user entry plus its provider id. */
interface ResolvedIntegration {
	server: string;
	label: string;
	type: "http" | "stdio";
	url?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	enabled?: boolean;
	/** Extra static HTTP headers from the user config. */
	headers?: Record<string, string>;
	enabledTools?: string[];
	disabledTools?: string[];
	/** True when this came from Settings.mcpServers (may override a catalog name). */
	userDeclared?: boolean;
}

const DEFAULT_LOCAL_MCP_SERVERS = {
	jcodemunch: {
		label: "jCodeMunch",
		command: "jcodemunch-mcp",
		enabledTools: [
			"search_symbols",
			"get_file_outline",
			"get_symbol_source",
			"get_context_bundle",
			"get_ranked_context",
			"find_references",
			"find_importers",
			"get_blast_radius",
			"get_changed_symbols",
			"plan_turn",
			"assemble_task_context",
		],
	},
	"context-mode": {
		label: "Context Mode",
		command: "context-mode",
		enabledTools: [
			"ctx_execute",
			"ctx_execute_file",
			"ctx_index",
			"ctx_search",
			"ctx_fetch_and_index",
			"ctx_batch_execute",
		],
	},
} as const;

const liveMcpManagers = new Set<McpManager>();
let mcpExitCleanupInstalled = false;

function registerMcpExitCleanup(manager: McpManager): void {
	liveMcpManagers.add(manager);
	if (mcpExitCleanupInstalled) return;
	mcpExitCleanupInstalled = true;
	process.once("exit", () => {
		for (const liveManager of liveMcpManagers) liveManager.disposeSync();
	});
}

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly cwd: string;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private integrations = new Map<string, ResolvedIntegration>();
	private readonly stdioClients = new Map<string, StdioMcpClient>();
	private readonly stdioOperationQueues = new Map<string, Promise<void>>();
	private disposed = false;
	private lifecycleGeneration = 0;
	/** Provider ids we registered for user servers, so refresh can drop removed ones. */
	private registeredUserProviderIds = new Set<string>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.cwd = options.cwd ?? process.cwd();
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.resolveIntegrations();
		this.registerProviders();
		registerMcpExitCleanup(this);
	}

	/** Re-read settings and re-register providers; call after a session reload. */
	refresh(): void {
		this.lifecycleGeneration += 1;
		this.disposed = false;
		// Refresh is an intentional lifecycle resurrection after session reload;
		// re-register so process-exit cleanup covers newly lazy-started sidecars.
		registerMcpExitCleanup(this);
		// Reload is a lifecycle boundary: never leave an old command/environment
		// running after settings are re-read. New processes remain lazy.
		this.disposeStdioClientsSync();
		this.resolveIntegrations();
		this.registerProviders();
	}

	/** Stop every sidecar owned by this workspace/session. */
	async dispose(): Promise<void> {
		const generation = this.lifecycleGeneration;
		this.disposed = true;
		const clients = [...this.stdioClients.entries()];
		this.stdioOperationQueues.clear();
		const results = await Promise.allSettled(clients.map(([, client]) => client.dispose()));
		const failures: unknown[] = [];
		for (const [index, result] of results.entries()) {
			const [server, client] = clients[index];
			if (result.status === "fulfilled") {
				if (this.stdioClients.get(server) === client) this.stdioClients.delete(server);
			} else {
				failures.push(result.reason);
			}
		}
		if (failures.length > 0) {
			// Keep failed clients owned and keep this manager live so a caller or the
			// process-exit hook can retry cleanup after a bounded shutdown failure.
			liveMcpManagers.add(this);
			const messages = failures.map((error) => (error instanceof Error ? error.message : String(error)));
			throw new AggregateError(failures, `Failed to dispose MCP stdio clients: ${messages.join("; ")}`);
		}
		if (generation === this.lifecycleGeneration) liveMcpManagers.delete(this);
		else liveMcpManagers.add(this);
	}

	/** Synchronous best-effort cleanup for process-exit/session replacement paths. */
	disposeSync(): void {
		this.disposed = true;
		liveMcpManagers.delete(this);
		this.disposeStdioClientsSync();
	}

	private providerId(server: string): string {
		return `mcp:${server}`;
	}

	private resolveIntegrations(): void {
		const integrations = new Map<string, ResolvedIntegration>();
		for (const entry of BUILTIN_MCP_CATALOG) {
			integrations.set(entry.server, {
				server: entry.server,
				label: entry.label,
				type: "http",
				url: entry.url,
				usesOAuth: entry.oauth?.kind === "oauth",
			});
		}
		// These bundled Python skills are available without a settings entry. The
		// command is only passed to StdioMcpClient here; construction does not spawn.
		for (const [server, { label, command, enabledTools }] of Object.entries(DEFAULT_LOCAL_MCP_SERVERS)) {
			integrations.set(server, {
				server,
				label,
				type: "stdio",
				command,
				args: [],
				cwd: this.cwd,
				env: {},
				enabledTools: [...enabledTools],
				usesOAuth: false,
			});
		}
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
			if (config.type === "http") {
				integrations.set(server, {
					server,
					label: server,
					type: "http",
					url: config.url,
					usesOAuth: config.oauth === true,
					bearerTokenEnvVar: config.bearerTokenEnvVar,
					enabled: config.enabled,
					headers: config.headers,
					enabledTools: config.enabledTools,
					disabledTools: config.disabledTools,
					userDeclared: true,
				});
				continue;
			}
			integrations.set(server, {
				server,
				label: server,
				type: "stdio",
				command: config.command,
				args: [...(config.args ?? [])],
				cwd: config.cwd ? resolve(this.cwd, config.cwd) : this.cwd,
				env: { ...config.env },
				usesOAuth: false,
				enabled: config.enabled,
				enabledTools: config.enabledTools,
				disabledTools: config.disabledTools,
				userDeclared: true,
			});
		}
		this.integrations = integrations;
	}

	private disposeStdioClientsSync(): void {
		for (const client of this.stdioClients.values()) client.disposeSync();
		this.stdioClients.clear();
		this.stdioOperationQueues.clear();
	}

	private registerProviders(): void {
		registerBuiltinMcpOAuthProviders();
		this.registerUserProviders();
	}

	/**
	 * Register OAuth providers for user-declared (non-catalog) servers. Public so it
	 * can run after ModelRegistry.refresh() resets the registry — otherwise custom
	 * `mcp:<server>` providers vanish on every refresh (e.g. post-login).
	 */
	registerUserProviders(): void {
		const current = new Set<string>();
		for (const integration of this.integrations.values()) {
			if (!integration.userDeclared) continue;
			const id = this.providerId(integration.server);
			if (integration.usesOAuth && integration.type === "http" && integration.url) {
				// Register pointing at the user's URL (overrides a catalog default too).
				current.add(id);
				registerOAuthProvider(
					createMcpOAuthProvider({
						server: integration.server,
						label: integration.label,
						url: integration.url,
					}),
				);
			} else if (getCatalogEntry(integration.server)) {
				// User overrode a catalog server with a custom URL but no oauth: drop the
				// built-in provider so we never send the official token to that URL.
				unregisterOAuthProvider(id);
			}
		}
		// Drop providers for user servers removed since the last registration.
		for (const id of this.registeredUserProviderIds) {
			if (!current.has(id)) unregisterOAuthProvider(id);
		}
		this.registeredUserProviderIds = current;
	}

	/** True when valid credentials exist for the integration (drives enablement). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.enabled === false) return false;
		// Local stdio servers are enabled by configuration; they do not use auth.json.
		if (integration.type === "stdio") return true;
		if (integration.bearerTokenEnvVar && process.env[integration.bearerTokenEnvVar]?.trim()) {
			return true;
		}
		// A user server that overrides a catalog name must NOT inherit the built-in's
		// stored mcp: creds — those were issued for the official endpoint and could be
		// sent to the override URL. Such an override authenticates only via a bearer
		// env var (handled above); we don't trust auth.json OAuth creds for it.
		if (integration.userDeclared && getCatalogEntry(integration.server)) {
			return false;
		}
		const cred = this.authStorage.get(this.providerId(integration.server));
		return cred !== undefined;
	}

	/** `-<server>/SKILL.md` overrides for every built-in integration the user isn't logged into. */
	getDisabledBuiltinSkillOverrides(): string[] {
		const overrides: string[] = [];
		for (const entry of BUILTIN_MCP_CATALOG) {
			const integration = this.integrations.get(entry.server);
			if (integration && !this.isAuthed(integration)) {
				overrides.push(`-${entry.server}/SKILL.md`);
			}
		}
		return overrides;
	}

	private getStdioIntegration(server: string): ResolvedIntegration {
		if (this.disposed) throw new Error("MCP manager is disposed");
		const integration = this.integrations.get(server);
		if (!integration || integration.type !== "stdio") {
			throw new Error(`MCP server ${server} is not configured as stdio`);
		}
		if (integration.enabled === false) {
			throw new Error(`MCP server ${server} is disabled`);
		}
		if (!integration.command || !integration.cwd) {
			throw new Error(`MCP server ${server} has an invalid stdio configuration`);
		}
		return integration;
	}

	private getStdioClient(server: string): StdioMcpClient {
		const integration = this.getStdioIntegration(server);
		const existing = this.stdioClients.get(server);
		if (existing) return existing;
		const client = new StdioMcpClient({
			server,
			command: integration.command!,
			args: integration.args ?? [],
			cwd: integration.cwd!,
			// Keep the configured env private to this child. It is never returned in a
			// host response or included in a diagnostic.
			env: { ...process.env, ...(integration.env ?? {}) },
		});
		this.stdioClients.set(server, client);
		return client;
	}

	private isToolAllowed(integration: ResolvedIntegration, tool: string): boolean {
		if (integration.enabledTools && !integration.enabledTools.includes(tool)) return false;
		return !integration.disabledTools?.includes(tool);
	}

	private async withStdioClient<T>(
		server: string,
		operation: (client: StdioMcpClient) => Promise<T>,
		options: { retryTransport?: boolean; retryOnlyIfRequestNotSent?: boolean } = {},
	): Promise<T> {
		const previous = this.stdioOperationQueues.get(server) ?? Promise.resolve();
		const queued = previous.then(async () => {
			const client = this.getStdioClient(server);
			try {
				return await operation(client);
			} catch (error) {
				// Read-only discovery can retry any transport failure. Tool calls may have
				// reached the server, so only a failure proven to precede the write is safe.
				if (
					options.retryTransport === false ||
					!isRetryableStdioMcpError(error) ||
					(options.retryOnlyIfRequestNotSent && !isStdioMcpRequestNotSentError(error))
				)
					throw error;
				await new Promise<void>((resolve) => {
					const timer = globalThis.setTimeout(resolve, 100);
					timer.unref?.();
				});
				await client.restart();
				return operation(client);
			}
		});
		const settled = queued.then(
			() => undefined,
			() => undefined,
		);
		this.stdioOperationQueues.set(server, settled);
		try {
			return await queued;
		} finally {
			if (this.stdioOperationQueues.get(server) === settled) this.stdioOperationQueues.delete(server);
		}
	}

	/** Host-request handlers exposed to the kernel. */
	hostHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
		const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
			"mcp.refresh": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.refresh requires a server");
				if (this.integrations.get(server)?.type === "stdio") return {};
				// getApiKey refreshes + rewrites auth.json under lock; Python re-reads.
				// Surface failure (throw) instead of a false success so the kernel can
				// report a refresh error rather than a misleading "not enabled".
				const key = await this.authStorage.getApiKey(this.providerId(server));
				if (!key) throw new Error(`Could not refresh credentials for ${server}`);
				return {};
			},
			// Resolved config so the kernel skill connects to the same URL the host
			// registered/authenticated (honors a user's mcpServers `url` override).
			"mcp.config": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.config requires a server");
				if (this.disposed) return { enabled: false };
				const integration = this.integrations.get(server);
				if (!integration) return {};
				// `enabled: false` is an explicit user boundary, not an authentication
				// hint. Return no endpoint so Python integrations cannot fall back to an
				// environment URL or establish an anonymous connection.
				if (integration.enabled === false) return { enabled: false };
				if (integration.type === "stdio") {
					// The command, cwd, and env stay host-side. Python receives only a
					// transport marker and uses the durable host bridge below.
					return { type: "stdio", bridge: "host" };
				}
				const config: Record<string, unknown> = { url: integration.url };
				if (integration.headers && Object.keys(integration.headers).length > 0) {
					config.headers = integration.headers;
				}
				if (integration.enabledTools) config.enabledTools = integration.enabledTools;
				if (integration.disabledTools) config.disabledTools = integration.disabledTools;
				return config;
			},
			"mcp.list_tools": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.list_tools requires a server");
				const integration = this.getStdioIntegration(server);
				const tools = await this.withStdioClient(server, (client) => client.listTools());
				return { tools: tools.filter((tool) => this.isToolAllowed(integration, tool.name)) };
			},
			"mcp.call_tool": async (payload) => {
				const server = String(payload.server ?? "");
				const tool = String(payload.tool ?? "");
				if (!server) throw new Error("mcp.call_tool requires a server");
				if (!tool) throw new Error("mcp.call_tool requires a tool");
				const integration = this.getStdioIntegration(server);
				if (!this.isToolAllowed(integration, tool)) {
					throw new Error(`MCP tool ${server}/${tool} is not allowed by settings`);
				}
				const arguments_ = payload.arguments;
				if (
					arguments_ !== undefined &&
					(typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_))
				) {
					throw new Error("mcp.call_tool arguments must be an object");
				}
				const result = await this.withStdioClient(
					server,
					(client) => client.callTool(tool, (arguments_ ?? {}) as Record<string, unknown>),
					{ retryOnlyIfRequestNotSent: true },
				);
				return { result };
			},
			"mcp.health": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.health requires a server");
				await this.withStdioClient(server, (client) => client.health());
				return { healthy: true };
			},
			"mcp.restart": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.restart requires a server");
				this.getStdioIntegration(server);
				await this.withStdioClient(server, (client) => client.restart(), { retryTransport: false });
				return { healthy: true };
			},
		};
		// Only expose begin_login when an interactive login is actually wired, so the
		// kernel doesn't get a handler whose only behavior is to throw.
		const beginLogin = this.beginLogin;
		if (beginLogin) {
			handlers["mcp.begin_login"] = async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.begin_login requires a server");
				await beginLogin(server);
				return {};
			};
		}
		return handlers;
	}

	/** Status for the /mcp list command. */
	listStatus(): Array<{ server: string; label: string; enabled: boolean; usesOAuth: boolean }> {
		return Array.from(this.integrations.values()).map((integration) => ({
			server: integration.server,
			label: integration.label,
			enabled: this.isAuthed(integration),
			usesOAuth: integration.usesOAuth,
		}));
	}
}
