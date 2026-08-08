import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.js";

const providersDoc = readFileSync(resolve(__dirname, "../docs/providers.md"), "utf-8");

describe("providers.md coverage", () => {
	it("documents every built-in provider", () => {
		const missing = Object.entries(BUILT_IN_PROVIDER_DISPLAY_NAMES)
			// prime-agent-traces is a telemetry-only provider, not an auth provider.
			.filter(([id]) => id !== "prime-agent-traces")
			.filter(([, name]) => !providersDoc.includes(name))
			.map(([id, name]) => `${id} (${name})`);

		expect(missing).toEqual([]);
	});
});
