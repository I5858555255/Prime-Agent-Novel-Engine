import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.js";
import type { ModelRegistry } from "../src/core/model-registry.js";

describe("listModels", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows provider-reported free status", async () => {
		const models: Model<"openai-completions">[] = [
			createModel("free-model", true),
			createModel("paid-model", false),
			createModel("unknown-model"),
		];
		const registry = {
			getError: () => undefined,
			refreshAvailableModels: async () => models,
		} as unknown as ModelRegistry;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listModels(registry);

		const lines = log.mock.calls.map(([line]) => String(line));
		expect(lines[0]).toMatch(/provider\s+model\s+free\s+context/);
		expect(lines.find((line) => line.includes("free-model"))).toMatch(/free-model\s+yes\s+/);
		expect(lines.find((line) => line.includes("paid-model"))).toMatch(/paid-model\s+no\s+/);
		expect(lines.find((line) => line.includes("unknown-model"))).toMatch(/unknown-model\s+-\s+/);
	});
});

function createModel(id: string, free?: boolean): Model<"openai-completions"> {
	return {
		id,
		name: id,
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
		free,
	};
}
