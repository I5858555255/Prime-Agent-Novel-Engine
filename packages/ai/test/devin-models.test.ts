import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { fetchDevinModels } from "../src/providers/devin-models.js";

const FREE_MODELS_RESPONSE = Buffer.from("Ci0KEEdMTSA1LjIgVGhpbmtpbmcoAZABgNAPsgEHZ2xtLTUuMroBBDICeAHAAQQ=", "base64");
const MIXED_MODELS_RESPONSE = Buffer.from(
	"CiUKC05vIFRoaW5raW5nkAGgjQayAQ1lbmFibGVkLW1vZGVswAEBCiMKDFVua25vd24gQ29zdLIBEnVua25vd24tY29zdC1tb2RlbAodCghEaXNhYmxlZCABsgEOZGlzYWJsZWQtbW9kZWw=",
	"base64",
);

describe("Devin model discovery", () => {
	it("fetches the authenticated account catalog and normalizes model metadata", async () => {
		const payload = FREE_MODELS_RESPONSE;
		const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(Buffer.from(init?.body as Uint8Array).includes(Buffer.from("devin-session-token$account-token"))).toBe(
				true,
			);
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
		const payload = gzipSync(MIXED_MODELS_RESPONSE);
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
