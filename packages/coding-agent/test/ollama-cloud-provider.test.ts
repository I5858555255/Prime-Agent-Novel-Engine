import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";
import { isApiKeyLoginProvider } from "../src/modes/interactive/auth-flows.js";

describe("Ollama Cloud provider", () => {
	it("uses the built-in display name and API-key login flow", () => {
		const providerIds = new Set(["ollama-cloud"]);

		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES["ollama-cloud"]).toBe("Ollama Cloud");
		expect(isApiKeyLoginProvider("ollama-cloud", providerIds, providerIds)).toBe(true);
	});
});
