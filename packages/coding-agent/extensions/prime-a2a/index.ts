/**
 * Prime Agent A2A extension.
 *
 * First-party Agent-to-Agent support:
 *   - `a2a_send` tool: call external A2A agents (peers or allowlisted URLs).
 *   - opt-in local A2A server: expose this instance as an A2A agent.
 *   - `/a2a` command: status, card, peers.
 *
 * Config lives in ~/.prime/agent/a2a.json and <project>/.prime/agent/a2a.json.
 * See packages/coding-agent/docs/a2a.md for the full reference and the mapping
 * to prime-swarm's interconnect design.
 */

import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { createAgentPromptBridge } from "./src/agent-bridge.js";
import { buildAgentCard } from "./src/card.js";
import { registerA2ASendTool } from "./src/client.js";
import { type A2AServerStatus, registerA2ACommands } from "./src/commands.js";
import { type A2AConfig, loadA2AConfig } from "./src/config.js";
import { type A2AServerHandle, createA2AServer } from "./src/server.js";

const WELL_KNOWN_PATH = "/.well-known/agent-card.json";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 41241;

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function emptyConfig(): A2AConfig {
	return {
		peers: {},
		allowedEndpoints: [],
		requestTimeoutMs: 120_000,
		server: { enabled: false, host: DEFAULT_HOST, port: DEFAULT_PORT },
	};
}

export default function (pi: ExtensionAPI): void {
	let config: A2AConfig = emptyConfig();
	let serverHandle: A2AServerHandle | undefined;
	let serverStatus: A2AServerStatus = { enabled: false, running: false };

	pi.registerFlag("a2a-serve", {
		description: "Start the local A2A server for this session (overrides a2a.json)",
		type: "boolean",
		default: false,
	});

	registerA2ASendTool(pi, () => config);
	registerA2ACommands(pi, { getConfig: () => config, getServerStatus: () => serverStatus });

	const bridge = createAgentPromptBridge(pi);

	async function stopServer(): Promise<void> {
		if (serverHandle) {
			try {
				await serverHandle.stop();
			} catch {
				// best-effort shutdown
			}
			serverHandle = undefined;
		}
	}

	async function startServer(notify: Notify): Promise<void> {
		const host = config.server.host ?? DEFAULT_HOST;
		const port = config.server.port ?? DEFAULT_PORT;
		const configuredBaseUrl = (config.server.publicUrl ?? `http://${host}:${port}`).replace(/\/+$/, "");
		const card = buildAgentCard({
			baseUrl: configuredBaseUrl,
			name: config.server.name ?? "Prime Agent",
			description: config.server.description ?? "A Prime Agent instance exposed over A2A.",
			version: VERSION || "0.0.1",
		});

		const handle = createA2AServer({ card, host, port, runPrompt: bridge.runPrompt });
		try {
			const bound = await handle.start();
			const baseUrl = config.server.publicUrl?.replace(/\/+$/, "") ?? `http://${bound.host}:${bound.port}`;
			if (!config.server.publicUrl) {
				Object.assign(
					card,
					buildAgentCard({
						baseUrl,
						name: config.server.name ?? "Prime Agent",
						description: config.server.description ?? "A Prime Agent instance exposed over A2A.",
						version: VERSION || "0.0.1",
					}),
				);
			}
			const cardUrl = `${baseUrl}${WELL_KNOWN_PATH}`;
			serverHandle = handle;
			serverStatus = { enabled: true, running: true, host: bound.host, port: bound.port, card, cardUrl };
			notify(`A2A server listening at http://${bound.host}:${bound.port}`, "info");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			serverStatus = {
				enabled: true,
				running: false,
				error: message,
				card,
				cardUrl: `${configuredBaseUrl}${WELL_KNOWN_PATH}`,
			};
			notify(`A2A server failed to start: ${message}`, "error");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await stopServer();
		config = loadA2AConfig(ctx.cwd);
		const forceServe = pi.getFlag("a2a-serve") === true;
		const enabled = forceServe || config.server.enabled === true;
		serverStatus = { enabled, running: false };
		if (enabled) await startServer((message, type) => ctx.ui.notify(message, type));
	});

	pi.on("session_shutdown", async () => {
		await stopServer();
		serverStatus = { ...serverStatus, running: false };
	});
}
