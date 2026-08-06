import { gunzipSync } from "node:zlib";
import { type FetchLike, listDevinModels } from "widevin";
import type { Model } from "../types.js";

const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
const DEVIN_MODELS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

export interface DevinModelDiscoveryOptions {
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetch?: FetchLike;
}

/**
 * Fetch the authenticated account's live Devin catalog. Widevin owns the
 * private Connect/protobuf contract; this adapter only adds Prime's model
 * shape and its provider-reported free-tier label.
 */
export async function fetchDevinModels(options: DevinModelDiscoveryOptions): Promise<Model<"devin-agent">[] | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	let pricingByModel = new Map<string, boolean | undefined>();
	const observingFetch: FetchLike = async (input, init) => {
		const response = await fetchImpl(input, init);
		const url = input instanceof Request ? input.url : String(input);
		if (!response.ok || !url.includes(DEVIN_MODELS_PATH)) return response;

		const payload = new Uint8Array(await response.clone().arrayBuffer());
		try {
			pricingByModel = decodeModelPricing(payload);
		} catch {
			pricingByModel = new Map();
		}
		return response;
	};

	try {
		const models = await listDevinModels({
			token: options.apiKey ?? "",
			baseUrl: options.baseUrl ?? DEVIN_DEFAULT_BASE_URL,
			fetch: observingFetch,
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
			free: pricingByModel.get(model.id),
		}));
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function decodeModelPricing(payload: Uint8Array): Map<string, boolean | undefined> {
	const bytes = payload[0] === 0x1f && payload[1] === 0x8b ? gunzipSync(payload) : payload;
	const pricing = new Map<string, boolean | undefined>();

	visitWireFields(bytes, (field, wireType, value) => {
		if (field !== 1 || wireType !== 2 || !(value instanceof Uint8Array)) return;
		let modelId: string | undefined;
		let costTier: number | undefined;
		visitWireFields(value, (configField, configWireType, configValue) => {
			if (configField === 22 && configWireType === 2 && configValue instanceof Uint8Array) {
				modelId = new TextDecoder().decode(configValue);
			} else if (configField === 24 && configWireType === 0 && typeof configValue === "bigint") {
				costTier = Number(configValue);
			}
		});
		if (modelId) {
			pricing.set(modelId, costTier === 4 ? true : costTier === undefined || costTier === 0 ? undefined : false);
		}
	});

	return pricing;
}

function visitWireFields(
	bytes: Uint8Array,
	visit: (field: number, wireType: number, value: bigint | Uint8Array) => void,
): void {
	let offset = 0;
	while (offset < bytes.length) {
		const tag = readVarint(bytes, offset);
		offset = tag.next;
		const field = Number(tag.value >> 3n);
		const wireType = Number(tag.value & 7n);

		switch (wireType) {
			case 0: {
				const value = readVarint(bytes, offset);
				offset = value.next;
				visit(field, wireType, value.value);
				break;
			}
			case 1:
				offset = checkedEnd(offset, 8, bytes.length);
				break;
			case 2: {
				const length = readVarint(bytes, offset);
				offset = length.next;
				const end = checkedEnd(offset, Number(length.value), bytes.length);
				visit(field, wireType, bytes.subarray(offset, end));
				offset = end;
				break;
			}
			case 5:
				offset = checkedEnd(offset, 4, bytes.length);
				break;
			default:
				throw new Error(`Unsupported protobuf wire type: ${wireType}`);
		}
	}
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; next: number } {
	let value = 0n;
	let shift = 0n;
	for (let offset = start; offset < bytes.length && offset < start + 10; offset++) {
		const byte = bytes[offset]!;
		value |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value, next: offset + 1 };
		shift += 7n;
	}
	throw new Error("Truncated protobuf varint");
}

function checkedEnd(offset: number, length: number, total: number): number {
	const end = offset + length;
	if (!Number.isSafeInteger(length) || length < 0 || end > total) {
		throw new Error("Truncated protobuf field");
	}
	return end;
}
