import { describe, expect, it } from "vitest";
import { getModels } from "../src/models.js";

describe("GitHub Copilot models", () => {
	it("routes grok-4.5 through the Responses API (#875)", () => {
		const model = getModels("github-copilot").find((candidate) => candidate.id === "grok-4.5");

		expect(model?.api).toBe("openai-responses");
	});
});
