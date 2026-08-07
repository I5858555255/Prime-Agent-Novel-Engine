import { describe, expect, test } from "vitest";
import { markCodingAgentProcess } from "../src/cli/process-marker.js";

describe("markCodingAgentProcess", () => {
	test("keeps the Pi marker and adds a Prime Agent marker for inherited subprocesses", () => {
		const env: NodeJS.ProcessEnv = {};

		markCodingAgentProcess(env);

		expect(env.PI_CODING_AGENT).toBe("true");
		expect(env.PRIME_AGENT).toBe("true");
	});
});
