import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Model } from "../types.js";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "./devin/proto/exa/api_server_pb/api_server_pb.js";
import {
	type ClientModelConfig,
	MetadataSchema,
	ModelCostTier,
} from "./devin/proto/exa/codeium_common_pb/codeium_common_pb.js";

const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEVIN_IDE_VERSION = "3.2.23";
const DEVIN_EXTENSION_VERSION = "1.48.2";
const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DevinModelDiscoveryOptions {
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: FetchFunction;
}

/** Fetch the models enabled for a Devin account through the authenticated Connect RPC. */
export async function fetchDevinModels(options: DevinModelDiscoveryOptions): Promise<Model<"devin-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const baseUrl = options.baseUrl ?? DEVIN_DEFAULT_BASE_URL;
	const requestUrl = `${baseUrl.replace(/\/+$/, "")}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	try {
		const request = create(GetCliModelConfigsRequestSchema, {
			metadata: create(MetadataSchema, {
				apiKey: normalizeDevinSessionToken(options.apiKey),
				ideName: "windsurf",
				ideVersion: DEVIN_IDE_VERSION,
				extensionName: "windsurf",
				extensionVersion: DEVIN_EXTENSION_VERSION,
			}),
		});
		const response = await (options.fetch ?? globalThis.fetch)(requestUrl, {
			method: "POST",
			headers: {
				"content-type": "application/proto",
				"connect-protocol-version": "1",
				accept: "*/*",
			},
			body: toBinary(GetCliModelConfigsRequestSchema, request),
			signal,
		});
		if (!response.ok) return null;

		const decoded = decodeCliModelConfigsResponse(new Uint8Array(await response.arrayBuffer()));
		return decoded ? normalizeDevinModels(decoded.clientModelConfigs, baseUrl) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

function decodeCliModelConfigsResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetCliModelConfigsResponseSchema, payload);
	} catch {
		try {
			return fromBinary(GetCliModelConfigsResponseSchema, gunzipSync(payload));
		} catch {
			return null;
		}
	}
}

function normalizeDevinModels(configs: readonly ClientModelConfig[], baseUrl: string): Model<"devin-agent">[] {
	const byId = new Map<string, Model<"devin-agent">>();
	for (const config of configs) {
		if (config.disabled) continue;
		const id = config.modelUid.trim();
		if (!id) continue;

		const contextWindow = config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW;
		byId.set(id, {
			id,
			name: config.label.trim() || id,
			api: "devin-agent",
			provider: "devin",
			baseUrl,
			reasoning: supportsDevinThinking(config),
			input: config.supportsImages ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			free:
				config.modelCostTier === ModelCostTier.FREE
					? true
					: config.modelCostTier === ModelCostTier.UNSPECIFIED
						? undefined
						: false,
			contextWindow,
			maxTokens: Math.min(contextWindow, DEFAULT_MAX_TOKENS),
		});
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function supportsDevinThinking(config: ClientModelConfig): boolean {
	if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
	return config.modelInfo?.modelFeatures?.supportsThinking === true || REASONING_LABEL_PATTERN.test(config.label);
}
