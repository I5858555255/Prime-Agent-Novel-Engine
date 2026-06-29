/**
 * The `/a2a` command: status, card, and peers.
 *
 *   /a2a status  - server state, card URL, peers, allowlist, timeout
 *   /a2a card    - print the local agent card (URL + JSON)
 *   /a2a peers   - list configured peers
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { A2AConfig } from "./config.js";

export interface A2AServerStatus {
	/** Server enabled in config. */
	enabled: boolean;
	/** Server currently listening. */
	running: boolean;
	host?: string;
	port?: number;
	card?: AgentCard;
	cardUrl?: string;
	/** Startup error, if the server failed to bind. */
	error?: string;
}

export interface A2ACommandDeps {
	getConfig: () => A2AConfig;
	getServerStatus: () => A2AServerStatus;
}

const SUBCOMMANDS = ["status", "card", "peers"] as const;

function renderStatus(deps: A2ACommandDeps): string {
	const config = deps.getConfig();
	const status = deps.getServerStatus();
	const peerNames = Object.keys(config.peers);

	const serverLine = status.error
		? `error: ${status.error}`
		: status.running
			? `running at http://${status.host}:${status.port}`
			: status.enabled
				? "enabled (not started)"
				: "disabled";

	const lines = ["A2A status", `  Server: ${serverLine}`];
	if (status.cardUrl) lines.push(`  Agent card: ${status.cardUrl}`);
	lines.push(
		`  Peers: ${peerNames.length > 0 ? `${peerNames.length} (${peerNames.join(", ")})` : "none"}`,
		`  Allowed endpoints: ${config.allowedEndpoints.length > 0 ? config.allowedEndpoints.join(", ") : "none"}`,
		`  Request timeout: ${config.requestTimeoutMs}ms`,
	);
	return lines.join("\n");
}

function renderCard(deps: A2ACommandDeps): string {
	const status = deps.getServerStatus();
	if (!status.card) {
		return "No agent card available. Enable the A2A server in a2a.json to generate one.";
	}
	const header = status.cardUrl ? `Agent card (${status.cardUrl}):` : "Agent card:";
	return `${header}\n${JSON.stringify(status.card, null, 2)}`;
}

function renderPeers(deps: A2ACommandDeps): string {
	const config = deps.getConfig();
	const entries = Object.entries(config.peers);
	if (entries.length === 0) {
		return "No peers configured. Add them under `peers` in ~/.prime/agent/a2a.json or <project>/.prime/agent/a2a.json.";
	}
	const lines = ["Configured A2A peers:"];
	for (const [name, peer] of entries) {
		const suffix = peer.description ? ` - ${peer.description}` : "";
		lines.push(`  ${name}: ${peer.url}${suffix}`);
	}
	return lines.join("\n");
}

export function registerA2ACommands(pi: ExtensionAPI, deps: A2ACommandDeps): void {
	pi.registerCommand("a2a", {
		description: "A2A status, card, and peers (/a2a status|card|peers)",
		getArgumentCompletions(argumentPrefix) {
			const prefix = argumentPrefix.trim();
			return SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
				value: name,
				label: name,
			}));
		},
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "status";
			switch (sub) {
				case "status":
					ctx.ui.notify(renderStatus(deps), "info");
					return;
				case "card":
					ctx.ui.notify(renderCard(deps), "info");
					return;
				case "peers":
					ctx.ui.notify(renderPeers(deps), "info");
					return;
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Use: ${SUBCOMMANDS.join(", ")}.`, "warning");
			}
		},
	});
}
