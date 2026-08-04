import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentConnectionSessionEvent } from "../agent-connection/types.js";
import { type PrimeAgentSessionMeta, primeAgentMeta } from "./acp-meta.js";

/**
 * Translate prime-agent session events into ACP `session/update` payloads.
 *
 * Kept as a pure function so the mapping is testable without a live ACP client
 * or a running agent. Returning an array lets one prime-agent event fan out to
 * several ACP updates (or none, for events ACP has no place for).
 */

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpSessionUpdate {
	sessionUpdate: string;
	[key: string]: unknown;
}

/** prime-agent's model-facing tool is IPython; bash is the secondary escape hatch. */
export const IPYTHON_TOOL_NAME = "ipython";

export function acpToolKind(toolName: string): AcpToolKind {
	switch (toolName) {
		case IPYTHON_TOOL_NAME:
		case "bash":
			return "execute";
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		default:
			return "other";
	}
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Map one streaming assistant event to an ACP chunk.
 *
 * The delta discriminator lives on the event itself (`text_delta` /
 * `thinking_delta`) and carries a plain string, so reasoning and visible answer
 * text are distinct ACP update kinds a client can render or hide separately.
 */
function assistantDeltaUpdates(event: AssistantMessageEvent): AcpSessionUpdate[] {
	if (event.type === "thinking_delta" && event.delta.length > 0) {
		return [{ sessionUpdate: "agent_thought_chunk", content: textContent(event.delta) }];
	}
	if (event.type === "text_delta" && event.delta.length > 0) {
		return [{ sessionUpdate: "agent_message_chunk", content: textContent(event.delta) }];
	}
	return [];
}

/** Extract the IPython cell source so a client can show what is executing. */
function ipythonCellSource(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function toolResultText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return undefined;
	const output = (result as { output?: unknown }).output;
	if (typeof output === "string") return output;
	const content = (result as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const parts = content
			.map((block) =>
				block && typeof block === "object" && (block as { type?: string }).type === "text"
					? ((block as { text?: string }).text ?? "")
					: "",
			)
			.filter(Boolean);
		if (parts.length > 0) return parts.join("\n");
	}
	return undefined;
}

/** Non-text IPython display data (plots, tables, JSON) has no ACP content type. */
function ipythonMimeBundle(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object") return undefined;
	const bundle =
		(result as { mimeBundle?: unknown; displayData?: unknown }).mimeBundle ??
		(result as { displayData?: unknown }).displayData;
	if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return undefined;
	const entries = Object.entries(bundle as Record<string, unknown>).filter(([mime]) => mime !== "text/plain");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function acpUpdatesForSessionEvent(event: AgentConnectionSessionEvent): AcpSessionUpdate[] {
	switch (event.type) {
		case "message_update":
			if (event.message.role !== "assistant") return [];
			return assistantDeltaUpdates(event.assistantMessageEvent);

		case "tool_execution_start": {
			const cell = event.toolName === IPYTHON_TOOL_NAME ? ipythonCellSource(event.args) : undefined;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: event.toolName === IPYTHON_TOOL_NAME ? "IPython cell" : event.toolName,
					kind: acpToolKind(event.toolName),
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: cell !== undefined ? { code: cell } : event.args,
				},
			];
		}

		case "tool_execution_end": {
			const text = toolResultText(event.result);
			const mimeBundle = event.toolName === IPYTHON_TOOL_NAME ? ipythonMimeBundle(event.result) : undefined;
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: (event.isError ? "failed" : "completed") satisfies AcpToolStatus,
					...(text ? { content: [{ type: "content", content: textContent(text) }] } : {}),
					...(mimeBundle ? { _meta: primeAgentMeta({ ipython: { mimeBundle } }) } : {}),
				},
			];
		}

		// Bash runs outside the tool-call lifecycle, so it gets a synthetic tool
		// call keyed by run id to keep incremental output addressable.
		case "bash_start":
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: bashToolCallId(event.runId),
					title: event.command,
					kind: "execute" satisfies AcpToolKind,
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: { command: event.command },
				},
			];

		case "bash_output":
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(undefined),
					status: "in_progress" satisfies AcpToolStatus,
					content: [{ type: "content", content: textContent(event.chunk) }],
				},
			];

		case "bash_end":
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(event.runId),
					status: (event.exitCode === 0 && !event.cancelled ? "completed" : "failed") satisfies AcpToolStatus,
				},
			];

		// Compaction, subagents, goals and recaps have no ACP equivalent: surface
		// them as namespaced metadata rather than distorting a standard update.
		case "compaction_end":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						compaction: {
							tokensBefore: event.result?.tokensBefore,
							summary: event.result?.summary,
						},
					}),
				},
			];

		case "rlm_child_update":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						subagents: [
							{
								id: event.child.id,
								sessionName: event.child.sessionName,
								status: event.child.status,
								model: event.child.model,
								tokenCount: event.child.tokenCount,
								error: event.child.error,
							},
						],
					}),
				},
			];

		default:
			return [];
	}
}

const BASH_TOOL_CALL_PREFIX = "prime-agent-bash";

export function bashToolCallId(runId: string | undefined): string {
	return runId ? `${BASH_TOOL_CALL_PREFIX}-${runId}` : BASH_TOOL_CALL_PREFIX;
}

export type { PrimeAgentSessionMeta };
