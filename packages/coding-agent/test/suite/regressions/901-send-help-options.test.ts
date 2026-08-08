import { describe, expect, it } from "vitest";
import { formatCommandHelp } from "../../../src/cli/command-registry.js";

describe("issue #901 send command help options", () => {
	it("does not list removed --steer or --follow-up flags in send command help", () => {
		const help = formatCommandHelp(["send"]);

		expect(help).toBeTruthy();
		expect(help).not.toContain("--steer");
		expect(help).not.toContain("--follow-up");
		expect(help).toContain("--from <agent>");
		expect(help).toContain("--json");
	});
});
