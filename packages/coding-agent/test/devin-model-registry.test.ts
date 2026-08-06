import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCliModelConfigsResponseSchema } from "../../ai/src/providers/devin/proto/exa/api_server_pb/api_server_pb.js";
import { ClientModelConfigSchema } from "../../ai/src/providers/devin/proto/exa/codeium_common_pb/codeium_common_pb.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("Devin model registry discovery", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let previousOffline: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-devin-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("devin", "account-token");
		previousOffline = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("replaces the static fallback with the authenticated account catalog", async () => {
		const payload = toBinary(
			GetCliModelConfigsResponseSchema,
			create(GetCliModelConfigsResponseSchema, {
				clientModelConfigs: [
					create(ClientModelConfigSchema, {
						label: "GLM 5.2",
						modelUid: "glm-5.2",
						maxTokens: 200_000,
					}),
				],
			}),
		);
		const fetchImpl = vi.fn(async () => new Response(payload, { status: 200 }));
		vi.stubGlobal("fetch", fetchImpl);
		const registry = ModelRegistry.inMemory(authStorage);

		const available = await registry.refreshAvailableModels();
		const devinModels = available.filter((model) => model.provider === "devin");

		expect(devinModels.map((model) => model.id)).toEqual(["glm-5.2"]);
		expect(registry.find("devin", "swe-1-6-slow")).toBeUndefined();
		expect(registry.find("devin", "glm-5.2")?.name).toBe("GLM 5.2");

		await registry.refreshAvailableModels();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("keeps the static fallback when account discovery fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);
		const registry = ModelRegistry.inMemory(authStorage);

		const available = await registry.refreshAvailableModels();

		expect(available.some((model) => model.provider === "devin" && model.id === "swe-1-6-slow")).toBe(true);
	});
});
