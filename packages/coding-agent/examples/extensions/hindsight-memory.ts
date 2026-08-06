/**
 * Server-backed long-term memory via Hindsight.
 *
 * Complements Prime Agent's session-local Continual Harness with cross-session
 * memory: relevant facts are recalled and injected before each prompt, and every
 * completed exchange is retained to a Hindsight memory bank. The same bank can be
 * shared across machines, sessions, and other agents.
 *
 * The extension talks to Hindsight's REST API with the global fetch, so it has no
 * dependencies. Hindsight already ships as first-party memory in comparable agents
 * (Hermes, Omnigent); this shows the same pattern via the extension hooks.
 *
 * Setup (environment variables):
 *   HINDSIGHT_API_KEY            Required. Bearer token (hsk_...). Unset -> extension no-ops.
 *   HINDSIGHT_BASE_URL           API base URL. Default: https://api.hindsight.vectorize.io
 *   HINDSIGHT_BANK_ID            Memory bank to read/write. Default: prime-agent
 *   HINDSIGHT_RECALL_BUDGET      Recall depth: low | mid | high. Default: mid
 *   HINDSIGHT_RECALL_MAX_TOKENS  Recall token budget. Default: 4096
 *
 * Usage:
 *   ./prime-agent.sh --extension packages/coding-agent/examples/extensions/hindsight-memory.ts
 *   # or copy to ~/.prime/agent/extensions/ for auto-discovery
 *   # /recall <query> looks up memories manually
 *
 * Hindsight: https://github.com/vectorize-io/hindsight
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface HindsightConfig {
	apiKey: string;
	baseUrl: string;
	bankId: string;
	budget: string;
	maxTokens: number;
}

interface RecallResult {
	id: string;
	text: string;
	type?: string | null;
	context?: string | null;
}

interface RecallResponse {
	results?: RecallResult[];
}

type ContentBlock = {
	type?: string;
	text?: string;
};

type MessageLike = {
	role?: string;
	content?: unknown;
};

const RECALL_BUDGETS = new Set(["low", "mid", "high"]);

const resolveConfig = (): HindsightConfig | null => {
	const apiKey = process.env.HINDSIGHT_API_KEY;
	if (!apiKey) {
		return null;
	}

	const rawBudget = process.env.HINDSIGHT_RECALL_BUDGET ?? "mid";
	const maxTokens = Number.parseInt(process.env.HINDSIGHT_RECALL_MAX_TOKENS ?? "", 10);

	return {
		apiKey,
		baseUrl: (process.env.HINDSIGHT_BASE_URL ?? "https://api.hindsight.vectorize.io").replace(/\/+$/, ""),
		bankId: process.env.HINDSIGHT_BANK_ID ?? "prime-agent",
		budget: RECALL_BUDGETS.has(rawBudget) ? rawBudget : "mid",
		maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
	};
};

const bankUrl = (config: HindsightConfig, suffix: string): string =>
	`${config.baseUrl}/v1/default/banks/${encodeURIComponent(config.bankId)}${suffix}`;

const authHeaders = (config: HindsightConfig): Record<string, string> => ({
	"content-type": "application/json",
	authorization: `Bearer ${config.apiKey}`,
});

const recall = async (config: HindsightConfig, query: string): Promise<RecallResult[]> => {
	const response = await fetch(bankUrl(config, "/memories/recall"), {
		method: "POST",
		headers: authHeaders(config),
		body: JSON.stringify({
			query,
			types: ["world", "experience"],
			budget: config.budget,
			max_tokens: config.maxTokens,
		}),
	});

	if (!response.ok) {
		throw new Error(`recall returned HTTP ${response.status}`);
	}

	const data = (await response.json()) as RecallResponse;
	return data.results ?? [];
};

const retain = async (config: HindsightConfig, content: string, context: string): Promise<void> => {
	const response = await fetch(bankUrl(config, "/memories"), {
		method: "POST",
		headers: authHeaders(config),
		body: JSON.stringify({ items: [{ content, context }], async: true }),
	});

	if (!response.ok) {
		throw new Error(`retain returned HTTP ${response.status}`);
	}
};

const formatMemories = (results: RecallResult[]): string =>
	results.map((result) => (result.context ? `- ${result.text} (${result.context})` : `- ${result.text}`)).join("\n");

const extractText = (content: unknown): string => {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}

	return parts.join("\n");
};

// Build a transcript of the latest exchange: the last user message and every
// assistant message that follows it.
const buildExchange = (messages: readonly unknown[]): string => {
	let start = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if ((messages[i] as MessageLike)?.role === "user") {
			start = i;
			break;
		}
	}

	const lines: string[] = [];
	for (let i = start; i < messages.length; i++) {
		const message = messages[i] as MessageLike;
		const role = message?.role;
		if (role !== "user" && role !== "assistant") {
			continue;
		}

		const text = extractText(message?.content).trim();
		if (text) {
			lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
		}
	}

	return lines.join("\n\n");
};

export default function (pi: ExtensionAPI) {
	let warnedMissingKey = false;

	const warnMissingKey = (ctx: ExtensionContext): void => {
		if (warnedMissingKey || !ctx.hasUI) {
			return;
		}
		warnedMissingKey = true;
		ctx.ui.notify("Hindsight: set HINDSIGHT_API_KEY to enable memory", "warning");
	};

	pi.on("before_agent_start", async (event, ctx) => {
		const config = resolveConfig();
		if (!config) {
			warnMissingKey(ctx);
			return;
		}

		const query = event.prompt.trim();
		if (!query) {
			return;
		}

		try {
			const results = await recall(config, query);
			if (results.length === 0) {
				return;
			}

			return {
				message: {
					customType: "hindsight-memory",
					content: `Relevant long-term memory (Hindsight):\n${formatMemories(results)}`,
					display: true,
				},
			};
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Hindsight recall failed: ${String(error)}`, "warning");
			}
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const config = resolveConfig();
		if (!config) {
			return;
		}

		const content = buildExchange(event.messages);
		if (!content) {
			return;
		}

		try {
			await retain(config, content, "prime-agent session");
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Hindsight retain failed: ${String(error)}`, "warning");
			}
		}
	});

	pi.registerCommand("recall", {
		description: "Recall relevant memories from Hindsight for a query",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = resolveConfig();
			if (!config) {
				warnMissingKey(ctx);
				return;
			}

			const query = args.trim();
			if (!query) {
				if (ctx.hasUI) {
					ctx.ui.notify("Usage: /recall <query>", "info");
				}
				return;
			}

			try {
				const results = await recall(config, query);
				if (ctx.hasUI) {
					ctx.ui.notify(results.length === 0 ? "No memories found" : formatMemories(results), "info");
				}
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Hindsight recall failed: ${String(error)}`, "warning");
				}
			}
		},
	});
}
