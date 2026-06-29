/**
 * Configuration loading for the Prime Agent MCP extension.
 *
 * Servers are declared in `mcp.json` style files using the same `mcpServers`
 * shape as other MCP clients, plus two Prime-specific keys: `directTools` and
 * `idleTimeoutMs`. Files are merged with project config overriding global
 * config. See docs/mcp.md for the precedence rules.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StdioServerConfig {
	type?: "stdio";
	/** Executable to spawn. */
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface HttpServerConfig {
	type?: "http";
	/** Streamable HTTP endpoint of the MCP server. */
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfig {
	mcpServers: Record<string, McpServerConfig>;
	/**
	 * Tools to promote to first-class tools, as `server/tool` references.
	 * These are registered with their full input schema instead of being
	 * reachable only through the `mcp` proxy tool.
	 */
	directTools: string[];
	/** Disconnect an idle server after this many ms. 0 disables idle disconnect. */
	idleTimeoutMs?: number;
}

export interface LoadedMcpConfig {
	config: McpConfig;
	/** Files that contributed to the merged config, highest precedence first. */
	sources: string[];
	/** Non-fatal problems (unreadable files, dropped directTools, etc.). */
	warnings: string[];
}

export function isHttpServer(config: McpServerConfig): config is HttpServerConfig {
	return "url" in config && typeof config.url === "string";
}

/**
 * Candidate config file paths, highest precedence first.
 *
 * 1. `<cwd>/.mcp.json` (project, shared convention)
 * 2. `<cwd>/.prime/agent/mcp.json` (project, Prime-specific)
 * 3. `~/.prime/agent/mcp.json` (global)
 */
export function configCandidatePaths(cwd: string, home: string = homedir()): string[] {
	return [join(cwd, ".mcp.json"), join(cwd, ".prime", "agent", "mcp.json"), join(home, ".prime", "agent", "mcp.json")];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate that a config value is a string map (e.g. `headers`, `env`). Values
 * must be strings so `${VAR}` expansion at connect time never hits a non-string.
 */
function parseStringRecord(
	value: unknown,
	name: string,
	field: string,
	source: string,
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`Invalid MCP config in ${source}: server "${name}" ${field} must be an object`);
	}
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new Error(`Invalid MCP config in ${source}: server "${name}" ${field}.${key} must be a string`);
		}
	}
	return value as Record<string, string>;
}

function parseServer(name: string, raw: unknown, source: string): McpServerConfig {
	if (!isRecord(raw)) {
		throw new Error(`Invalid MCP config in ${source}: server "${name}" must be an object`);
	}

	if (typeof raw.url === "string" && typeof raw.command === "string") {
		throw new Error(
			`Invalid MCP config in ${source}: server "${name}" defines both "command" (stdio) and "url" (http); use one transport`,
		);
	}

	if (typeof raw.url === "string") {
		const headers = parseStringRecord(raw.headers, name, "headers", source);
		return { type: "http", url: raw.url, headers };
	}

	if (typeof raw.command === "string") {
		const args = raw.args;
		if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
			throw new Error(`Invalid MCP config in ${source}: server "${name}" args must be an array of strings`);
		}
		const env = parseStringRecord(raw.env, name, "env", source);
		if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
			throw new Error(`Invalid MCP config in ${source}: server "${name}" cwd must be a string`);
		}
		return {
			type: "stdio",
			command: raw.command,
			args: args as string[] | undefined,
			env,
			cwd: raw.cwd,
		};
	}

	throw new Error(
		`Invalid MCP config in ${source}: server "${name}" must define either "command" (stdio) or "url" (http)`,
	);
}

interface ParsedFile {
	mcpServers: Record<string, McpServerConfig>;
	directTools: string[];
	idleTimeoutMs?: number;
}

function parseConfigFile(text: string, source: string): ParsedFile {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in MCP config ${source}: ${message}`);
	}

	if (!isRecord(json)) {
		throw new Error(`Invalid MCP config in ${source}: top level must be an object`);
	}

	const servers: Record<string, McpServerConfig> = {};
	const rawServers = json.mcpServers;
	if (rawServers !== undefined) {
		if (!isRecord(rawServers)) {
			throw new Error(`Invalid MCP config in ${source}: "mcpServers" must be an object`);
		}
		for (const [name, raw] of Object.entries(rawServers)) {
			if (name === "__proto__" || name === "constructor" || name === "prototype") {
				throw new Error(`Invalid MCP config in ${source}: server name "${name}" is reserved`);
			}
			servers[name] = parseServer(name, raw, source);
		}
	}

	const directTools: string[] = [];
	const rawDirect = json.directTools;
	if (rawDirect !== undefined) {
		if (!Array.isArray(rawDirect) || rawDirect.some((entry) => typeof entry !== "string")) {
			throw new Error(`Invalid MCP config in ${source}: "directTools" must be an array of "server/tool" strings`);
		}
		directTools.push(...(rawDirect as string[]));
	}

	let idleTimeoutMs: number | undefined;
	const rawIdle = json.idleTimeoutMs;
	if (rawIdle !== undefined) {
		if (typeof rawIdle !== "number" || !Number.isFinite(rawIdle) || rawIdle < 0) {
			throw new Error(`Invalid MCP config in ${source}: "idleTimeoutMs" must be a non-negative number`);
		}
		idleTimeoutMs = rawIdle;
	}

	return { mcpServers: servers, directTools, idleTimeoutMs };
}

async function readConfigFile(path: string): Promise<ParsedFile | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// Treat "not found" and "a path component isn't a directory" as absent so
		// an unrelated layout (e.g. a file where `.prime/` is expected) doesn't
		// disable every other config file.
		if (code === "ENOENT" || code === "ENOTDIR") {
			return undefined;
		}
		throw error;
	}
	return parseConfigFile(text, path);
}

/**
 * Load and merge MCP config from all candidate paths.
 *
 * Lower-precedence files are applied first, so higher-precedence files override
 * servers with the same name. `directTools` are unioned and `idleTimeoutMs` from
 * the highest-precedence file that sets it takes effect.
 *
 * A file that cannot be read or parsed is skipped with a warning rather than
 * failing the whole load, so one bad file never disables every other config.
 *
 * A `directTools` entry is only honored when the config file that declared it is
 * the same one that won the referenced server's definition. This stops a
 * lower-trust file (e.g. a repo `.mcp.json`) from redefining a server name that
 * a higher-trust file (e.g. `~/.prime/agent/mcp.json`) opted to auto-promote,
 * which would otherwise spawn an attacker-controlled command at startup.
 */
export async function loadMcpConfig(cwd: string, home: string = homedir()): Promise<LoadedMcpConfig> {
	const paths = configCandidatePaths(cwd, home);
	const merged: McpConfig = { mcpServers: {}, directTools: [] };
	const sources: string[] = [];
	const warnings: string[] = [];

	const serverSource = new Map<string, string>();
	const directToolSources = new Map<string, Set<string>>();
	let idleTimeoutMs: number | undefined;

	// Apply from lowest to highest precedence so later overlays win.
	for (const path of [...paths].reverse()) {
		let parsed: ParsedFile | undefined;
		try {
			parsed = await readConfigFile(path);
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		if (!parsed) continue;
		sources.unshift(path);

		for (const [name, server] of Object.entries(parsed.mcpServers)) {
			merged.mcpServers[name] = server;
			serverSource.set(name, path);
		}
		for (const ref of parsed.directTools) {
			let set = directToolSources.get(ref);
			if (!set) {
				set = new Set();
				directToolSources.set(ref, set);
			}
			set.add(path);
		}
		if (parsed.idleTimeoutMs !== undefined) idleTimeoutMs = parsed.idleTimeoutMs;
	}

	if (idleTimeoutMs !== undefined) merged.idleTimeoutMs = idleTimeoutMs;

	for (const [ref, declaredIn] of directToolSources) {
		const parsedRef = parseToolRef(ref);
		// Keep malformed refs and refs to unknown servers; both are reported with a
		// clearer message later by registerDirectTools.
		const winner = parsedRef ? serverSource.get(parsedRef.server) : undefined;
		if (parsedRef && winner !== undefined && !declaredIn.has(winner)) {
			warnings.push(
				`Ignoring directTools entry "${ref}": server "${parsedRef.server}" is defined by ${winner}, ` +
					`which did not opt into promoting it`,
			);
			continue;
		}
		merged.directTools.push(ref);
	}

	return { config: merged, sources, warnings };
}

/** Split a `server/tool` reference. Tool names may contain slashes. */
export function parseToolRef(ref: string): { server: string; tool: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { server: ref.slice(0, slash), tool: ref.slice(slash + 1) };
}
