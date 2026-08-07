import { type FetchLike, listDevinModels } from "widevin";
import type { Model } from "../types.js";

const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

export interface DevinModelDiscoveryOptions {
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: FetchLike;
}

export async function fetchDevinModels(options: DevinModelDiscoveryOptions): Promise<Model<"devin-agent">[] | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	try {
		const models = await listDevinModels({
			token: options.apiKey ?? "",
			baseUrl: options.baseUrl ?? DEVIN_DEFAULT_BASE_URL,
			fetch: options.fetch,
			signal,
		});
		return models.map((model) => ({
			id: model.id,
			name: model.name,
			api: "devin-agent",
			provider: "devin",
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: [...model.input],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
