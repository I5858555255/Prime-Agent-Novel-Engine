/**
 * Default connector that wires the manager to real MCP servers via the
 * `@modelcontextprotocol/sdk` client and its stdio / streamable-HTTP transports.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isHttpServer, type McpServerConfig } from "./config.js";
import type { McpCallResult, McpClientLike, McpConnector, McpToolInfo } from "./manager.js";

const CLIENT_INFO = { name: "prime-agent-mcp", version: "0.2.2" } as const;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Expand `${VAR}` references in a string from the current environment. Missing vars become "". */
function expandEnv(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function expandRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) out[key] = expandEnv(value);
	return out;
}

function buildTransport(config: McpServerConfig) {
	if (isHttpServer(config)) {
		const headers = expandRecord(config.headers);
		return new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: headers ? { headers } : undefined,
		});
	}
	return new StdioClientTransport({
		command: config.command,
		args: config.args,
		// Start from the SDK's safe default env (PATH, HOME, ...) rather than the
		// full parent environment, then overlay only the config-provided vars.
		env: { ...getDefaultEnvironment(), ...expandRecord(config.env) },
		cwd: config.cwd,
		stderr: "ignore",
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function adaptClient(client: Client, transport?: StreamableHTTPClientTransport): McpClientLike {
	return {
		async listTools(signal) {
			const tools: McpToolInfo[] = [];
			let cursor: string | undefined;
			do {
				const page = await client.listTools({ cursor }, { signal, timeout: DEFAULT_REQUEST_TIMEOUT_MS });
				for (const tool of page.tools) {
					tools.push({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema as Record<string, unknown>,
					});
				}
				cursor = page.nextCursor as string | undefined;
			} while (cursor);
			return tools;
		},
		async callTool(tool, args, signal): Promise<McpCallResult> {
			const result = (await client.callTool({ name: tool, arguments: args }, undefined, {
				signal,
				timeout: DEFAULT_REQUEST_TIMEOUT_MS,
			})) as {
				content?: unknown;
				toolResult?: unknown;
				isError?: boolean;
				structuredContent?: Record<string, unknown>;
			};
			return {
				content: result.content ?? result.toolResult,
				isError: result.isError === true,
				structuredContent: result.structuredContent,
			};
		},
		async close() {
			// End the server-side session for HTTP transports so idle disconnects
			// and shutdown don't accumulate abandoned sessions on the remote.
			if (transport) {
				try {
					await transport.terminateSession();
				} catch {
					// Server may not support explicit termination; close anyway.
				}
			}
			await client.close();
		},
	};
}

export interface ConnectorOptions {
	connectTimeoutMs?: number;
}

export function createDefaultConnector(options: ConnectorOptions = {}): McpConnector {
	const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	return async (name, config, signal) => {
		const client = new Client(CLIENT_INFO);
		const transport = buildTransport(config);
		try {
			await withTimeout(
				client.connect(transport, { signal }),
				connectTimeoutMs,
				`Connecting to MCP server "${name}"`,
			);
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
		return adaptClient(client, transport instanceof StreamableHTTPClientTransport ? transport : undefined);
	};
}
