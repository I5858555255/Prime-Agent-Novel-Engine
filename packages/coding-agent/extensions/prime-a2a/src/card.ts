/**
 * Agent Card construction for the local A2A server.
 *
 * The card is the agent's public identity document served at
 * `/.well-known/agent-card.json`. To orchestrators like prime-swarm it is an
 * opaque blob; only this extension parses it. We keep generation in one place so
 * the served card and the `/a2a card` command stay in sync.
 */

import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

/** A2A protocol version this card targets. */
const A2A_PROTOCOL_VERSION = "0.3.0";

export interface BuildAgentCardOptions {
	/** Public base URL where the JSON-RPC endpoint is reachable (no trailing slash). */
	baseUrl: string;
	/** Display name. */
	name: string;
	/** Human description of what this agent does. */
	description: string;
	/** Agent version string. */
	version: string;
	/** Skills to advertise. Defaults to a single general coding skill. */
	skills?: AgentSkill[];
}

const DEFAULT_SKILL: AgentSkill = {
	id: "general",
	name: "General coding assistance",
	description:
		"Answers questions and performs software engineering tasks in this agent's working directory, " +
		"returning the final text response.",
	tags: ["coding", "general"],
	examples: ["Summarize the architecture of this repository", "Fix the failing test in src/foo.ts"],
};

/**
 * Build an A2A agent card describing this Prime Agent instance.
 *
 * Streaming and push notifications are advertised as unsupported because the v1
 * server returns a single completed task per request.
 */
export function buildAgentCard(options: BuildAgentCardOptions): AgentCard {
	const url = options.baseUrl.replace(/\/+$/, "");
	return {
		protocolVersion: A2A_PROTOCOL_VERSION,
		name: options.name,
		description: options.description,
		version: options.version,
		url,
		preferredTransport: "JSONRPC",
		capabilities: {
			streaming: false,
			pushNotifications: false,
			stateTransitionHistory: false,
		},
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: options.skills && options.skills.length > 0 ? options.skills : [DEFAULT_SKILL],
	};
}
