import { gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "../src/providers/devin/proto/exa/api_server_pb/api_server_pb.js";
import {
	ClientModelConfigSchema,
	ModelCostTier,
} from "../src/providers/devin/proto/exa/codeium_common_pb/codeium_common_pb.js";
import { fetchDevinModels } from "../src/providers/devin-models.js";

describe("Devin model discovery", () => {
	it("fetches the authenticated account catalog and normalizes model metadata", async () => {
		const payload = toBinary(
			GetCliModelConfigsResponseSchema,
			create(GetCliModelConfigsResponseSchema, {
				clientModelConfigs: [
					create(ClientModelConfigSchema, {
						label: "GLM 5.2 Thinking",
						modelUid: "glm-5.2",
						maxTokens: 256_000,
						supportsImages: true,
						modelCostTier: ModelCostTier.FREE,
					}),
				],
			}),
		);
		const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const request = fromBinary(GetCliModelConfigsRequestSchema, new Uint8Array(init?.body as Uint8Array));
			expect(request.metadata?.apiKey).toBe("devin-session-token$account-token");
			expect(init?.headers).toMatchObject({
				"content-type": "application/proto",
				"connect-protocol-version": "1",
			});
			return new Response(payload, { status: 200 });
		});

		await expect(fetchDevinModels({ apiKey: "account-token", fetch: fetchImpl })).resolves.toEqual([
			expect.objectContaining({
				id: "glm-5.2",
				name: "GLM 5.2 Thinking",
				provider: "devin",
				api: "devin-agent",
				contextWindow: 256_000,
				maxTokens: 64_000,
				reasoning: true,
				input: ["text", "image"],
				free: true,
			}),
		]);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("filters disabled entries and accepts gzip-compressed responses", async () => {
		const payload = gzipSync(
			toBinary(
				GetCliModelConfigsResponseSchema,
				create(GetCliModelConfigsResponseSchema, {
					clientModelConfigs: [
						create(ClientModelConfigSchema, {
							label: "No Thinking",
							modelUid: "enabled-model",
							maxTokens: 100_000,
							modelCostTier: ModelCostTier.LOW,
						}),
						create(ClientModelConfigSchema, {
							label: "Unknown Cost",
							modelUid: "unknown-cost-model",
						}),
						create(ClientModelConfigSchema, {
							label: "Disabled",
							modelUid: "disabled-model",
							disabled: true,
						}),
					],
				}),
			),
		);
		const fetchImpl = vi.fn(async () => new Response(payload, { status: 200 }));

		await expect(fetchDevinModels({ apiKey: "token", fetch: fetchImpl })).resolves.toEqual([
			expect.objectContaining({ id: "enabled-model", reasoning: false, input: ["text"], free: false }),
			expect.objectContaining({ id: "unknown-cost-model", free: undefined }),
		]);
	});

	it("returns null when discovery fails", async () => {
		const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
		await expect(fetchDevinModels({ apiKey: "token", fetch: fetchImpl })).resolves.toBeNull();
	});
});
