/**
 * Configuration loading for the A2A extension.
 *
 * Config is read from two optional JSON files and merged, with the project
 * file taking precedence over the user file:
 *
 *   - User:    ~/.prime/agent/a2a.json
 *   - Project: <cwd>/.prime/agent/a2a.json
 *
 * The shape is intentionally small. Peers name external A2A agents the model
 * may reach via the `a2a_send` tool. `allowedEndpoints` is the egress allowlist
 * for ad-hoc URLs; reaching an external agent is opt-in per host, mirroring the
 * default-deny egress posture described in prime-swarm's interconnect design.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** A named external A2A agent the model may call. */
export interface A2APeerConfig {
	/** Base URL of the agent, or a full URL to its agent card. */
	url: string;
	/** Optional override for the agent card path (defaults to .well-known/agent-card.json). */
	cardPath?: string;
	/** Optional human description shown in `/a2a peers`. */
	description?: string;
}

/** Settings for the optional local A2A server. */
export interface A2AServerConfig {
	/** Whether the server starts on session start. Default false. */
	enabled?: boolean;
	/** Interface to bind. Default 127.0.0.1 (loopback only). */
	host?: string;
	/** Port to listen on. Default 41241. */
	port?: number;
	/** Display name advertised in the agent card. */
	name?: string;
	/** Description advertised in the agent card. */
	description?: string;
	/** Public base URL advertised in the agent card, if the server is reverse-proxied. */
	publicUrl?: string;
}

/** Fully-resolved A2A configuration. */
export interface A2AConfig {
	peers: Record<string, A2APeerConfig>;
	/** Egress allowlist patterns for ad-hoc URLs (origins, optionally with a `*.` host wildcard). */
	allowedEndpoints: string[];
	/** Timeout applied to a single `a2a_send` call, in milliseconds. */
	requestTimeoutMs: number;
	server: A2AServerConfig;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SERVER_PORT = 41241;
const DEFAULT_SERVER_HOST = "127.0.0.1";

/** Raw, unvalidated shape as it may appear on disk (all fields optional). */
interface A2AConfigFile {
	peers?: Record<string, A2APeerConfig>;
	allowedEndpoints?: string[];
	requestTimeoutMs?: number;
	server?: A2AServerConfig;
}

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return homedir() + path.slice(1);
	return path;
}

function readConfigFile(path: string): A2AConfigFile {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed && typeof parsed === "object") return parsed as A2AConfigFile;
		console.error(`prime-a2a: ignoring ${path}: expected a JSON object`);
	} catch (err) {
		console.error(`prime-a2a: could not parse ${path}: ${err instanceof Error ? err.message : err}`);
	}
	return {};
}

function mergeConfig(base: A2AConfigFile, override: A2AConfigFile): A2AConfigFile {
	return {
		peers: { ...(base.peers ?? {}), ...(override.peers ?? {}) },
		allowedEndpoints: dedupe([...arrayOrEmpty(base.allowedEndpoints), ...arrayOrEmpty(override.allowedEndpoints)]),
		requestTimeoutMs: override.requestTimeoutMs ?? base.requestTimeoutMs,
		server: { ...(base.server ?? {}), ...(override.server ?? {}) },
	};
}

function arrayOrEmpty(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

/** Path to the user-level config file (~/.prime/agent/a2a.json). */
export function getUserConfigPath(): string {
	return join(getAgentDir(), "a2a.json");
}

/** Path to the project-level config file (<cwd>/.prime/agent/a2a.json). */
export function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".prime", "agent", "a2a.json");
}

/** Load and merge user + project config into a fully-resolved A2AConfig. */
export function loadA2AConfig(cwd: string): A2AConfig {
	const user = readConfigFile(getUserConfigPath());
	const project = readConfigFile(getProjectConfigPath(cwd));
	const merged = mergeConfig(user, project);

	return {
		peers: merged.peers ?? {},
		allowedEndpoints: merged.allowedEndpoints ?? [],
		requestTimeoutMs: merged.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
		server: {
			enabled: merged.server?.enabled ?? false,
			host: merged.server?.host ?? DEFAULT_SERVER_HOST,
			port: merged.server?.port ?? DEFAULT_SERVER_PORT,
			name: merged.server?.name,
			description: merged.server?.description,
			publicUrl: expandTilde(merged.server?.publicUrl ?? "").trim() || undefined,
		},
	};
}

interface ParsedPattern {
	protocol: string;
	hostname: string;
	port: string;
}

/** Parse an allowlist pattern or URL into protocol/hostname/port for comparison. */
function parsePattern(pattern: string): ParsedPattern | null {
	// new URL() rejects "*" in the host, so substitute a placeholder label first.
	const placeholder = "wildcard-placeholder";
	const probe = pattern.includes("://") ? pattern : `https://${pattern}`;
	try {
		const url = new URL(probe.replace(/\*/g, placeholder));
		return {
			protocol: url.protocol,
			hostname: url.hostname.split(placeholder).join("*"),
			port: url.port,
		};
	} catch {
		return null;
	}
}

function hostnameMatches(patternHost: string, host: string): boolean {
	if (patternHost === host) return true;
	if (patternHost.startsWith("*.")) {
		const suffix = patternHost.slice(1); // ".example.com"
		return host.endsWith(suffix) && host.length > suffix.length;
	}
	return false;
}

function patternMatches(pattern: ParsedPattern, target: URL): boolean {
	if (pattern.protocol !== target.protocol) return false;
	if (!hostnameMatches(pattern.hostname, target.hostname)) return false;
	const patternPort = pattern.port || defaultPortForProtocol(pattern.protocol);
	const targetPort = target.port || defaultPortForProtocol(target.protocol);
	if (patternPort !== targetPort) return false;
	return true;
}

function defaultPortForProtocol(protocol: string): string {
	if (protocol === "https:") return "443";
	if (protocol === "http:") return "80";
	return "";
}

/**
 * Whether a target URL is permitted by the egress allowlist.
 *
 * Configured peer URLs are implicitly allowed (adding a peer is an explicit
 * opt-in). Any other URL must match an `allowedEndpoints` pattern. With no
 * matching entry the call is denied, keeping the default-deny posture.
 */
export function isEndpointAllowed(targetUrl: string, config: A2AConfig): boolean {
	let target: URL;
	try {
		target = new URL(targetUrl);
	} catch {
		return false;
	}

	const patterns = [...config.allowedEndpoints, ...Object.values(config.peers).map((peer) => peer.url)];
	for (const raw of patterns) {
		const parsed = parsePattern(raw);
		if (parsed && patternMatches(parsed, target)) return true;
	}
	return false;
}
