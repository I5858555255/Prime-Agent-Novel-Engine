/**
 * Bridges inbound A2A requests to the running Prime Agent session.
 *
 * An inbound A2A message becomes a user turn via `pi.sendUserMessage`, and the
 * agent's reply is captured from that turn's `agent_end` event. Requests are
 * serialized so two callers (or a caller and a local user) cannot interleave a
 * turn. This expects an otherwise-idle session; running the server alongside
 * heavy interactive use will mix A2A turns with user turns.
 *
 * In prime-swarm terms this is the local stand-in for a "Relayed prompt": swarm
 * would deliver the prompt with Provenance::Relayed and a correlation id, and
 * read the reply back over `subscribe`. Here the extension owns that round-trip
 * inside the agent image. See docs/a2a.md.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PromptBridge {
	/** Send `text` as a user turn and resolve with the agent's final reply text. */
	runPrompt(text: string, signal?: AbortSignal): Promise<string>;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return (
		!!part &&
		typeof part === "object" &&
		(part as { type?: unknown }).type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

/** Extract the last assistant message's text from a finished agent run. */
export function getFinalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content: unknown = message.content;
		if (typeof content === "string") {
			if (content.trim()) return content.trim();
			continue;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter(isTextPart)
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}

/** Minimal FIFO async mutex. */
class Mutex {
	private tail: Promise<void> = Promise.resolve();

	acquire(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.tail;
		this.tail = this.tail.then(() => next);
		return previous.then(() => release);
	}
}

/**
 * Create a prompt bridge over the extension API. Registers persistent listeners
 * that capture the in-flight request's final messages, if any.
 */
export function createAgentPromptBridge(pi: ExtensionAPI): PromptBridge {
	interface PendingPrompt {
		text: string;
		started: boolean;
		messages: AgentMessage[] | undefined;
	}

	let pending: PendingPrompt | null = null;
	let activeTurns = 0;
	const mutex = new Mutex();

	pi.on("before_agent_start", (event) => {
		if (pending && !pending.started && event.prompt === pending.text) {
			pending.started = true;
		}
	});

	pi.on("agent_start", () => {
		activeTurns++;
	});

	pi.on("agent_end", (event) => {
		if (activeTurns > 0) activeTurns--;
		if (pending?.started) {
			pending.messages = event.messages;
		}
	});

	async function runPrompt(text: string, signal?: AbortSignal): Promise<string> {
		const release = await mutex.acquire();

		// Refuse if a turn is already running (e.g. interactive use). sendUserMessage
		// would queue behind it and the next agent_end would belong to that turn, so
		// we would otherwise hand the caller someone else's reply.
		if (activeTurns > 0) {
			release();
			throw new Error("Agent is busy with another turn; A2A requests require an otherwise-idle session.");
		}

		const current: PendingPrompt = { text, started: false, messages: undefined };
		pending = current;

		const prompt = (async () => {
			try {
				await pi.sendUserMessage(text);
				return getFinalAssistantText(current.messages ?? []);
			} finally {
				if (pending === current) pending = null;
				// Release the lock only once the submitted prompt completes, so
				// auto-retry and late agent_end events cannot leak into the next caller.
				release();
			}
		})();

		void prompt.catch(() => undefined);

		if (!signal) return prompt;

		return Promise.race([
			prompt,
			new Promise<string>((_, reject) => {
				if (signal.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		]);
	}

	return { runPrompt };
}
