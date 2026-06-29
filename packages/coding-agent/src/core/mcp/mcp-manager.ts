// Host side of MCP integrations. The protocol itself runs Python-side in the kernel; the host
// only registers OAuth providers, gates integration skills by auth, and serves mcp.* host-requests.

import {
	BUILTIN_MCP_CATALOG,
	createMcpOAuthProvider,
	registerBuiltinMcpOAuthProviders,
} from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";

export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
}

/** A resolved integration: a catalog/user entry plus its provider id. */
interface ResolvedIntegration {
	server: string;
	label: string;
	url: string;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	enabled?: boolean;
	/** True when this came from Settings.mcpServers (may override a catalog name). */
	userDeclared?: boolean;
}

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private integrations = new Map<string, ResolvedIntegration>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.resolveIntegrations();
		this.registerProviders();
	}

	/** Re-read settings and re-register providers; call after a session reload. */
	refresh(): void {
		this.resolveIntegrations();
		this.registerProviders();
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
				url: entry.url,
				usesOAuth: entry.oauth?.kind === "oauth",
			});
		}
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
			if (config.type !== "http") continue; // stdio servers self-manage in Python
			integrations.set(server, {
				server,
				label: server,
				url: config.url,
				usesOAuth: config.oauth === true,
				bearerTokenEnvVar: config.bearerTokenEnvVar,
				enabled: config.enabled,
				userDeclared: true,
			});
		}
		this.integrations = integrations;
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
		for (const integration of this.integrations.values()) {
			// Register based on userDeclared (not getCatalogEntry) so a user server that
			// overrides a catalog name still gets a provider pointed at its own URL.
			if (!integration.usesOAuth || !integration.userDeclared) continue;
			registerOAuthProvider(
				createMcpOAuthProvider({
					server: integration.server,
					label: integration.label,
					url: integration.url,
				}),
			);
		}
	}

	/** True when valid credentials exist for the integration (drives enablement). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.enabled === false) return false;
		if (integration.bearerTokenEnvVar && process.env[integration.bearerTokenEnvVar]?.trim()) {
			return true;
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

	/** Host-request handlers exposed to the kernel. */
	hostHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
		const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
			"mcp.refresh": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.refresh requires a server");
				// getApiKey refreshes + rewrites auth.json under lock; Python re-reads.
				await this.authStorage.getApiKey(this.providerId(server));
				return {};
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
