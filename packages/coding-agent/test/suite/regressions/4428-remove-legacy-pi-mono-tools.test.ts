import { describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.js";
import { allToolNames, createAllToolDefinitions } from "../../../src/core/tools/index.js";

describe("regression #4428: remove legacy pi-mono built-in tools", () => {
	it("registers only ipython as a built-in tool", () => {
		expect([...allToolNames]).toEqual(["ipython"]);
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual(["ipython"]);
	});

	it("reports bash and edit as removed built-in tools", () => {
		const result = parseArgs(["--tools", "bash,edit,ipython"]);

		expect(result.tools).toEqual(["bash", "edit", "ipython"]);
		expect(result.diagnostics).toContainEqual({
			type: "error",
			message: "Unknown built-in tool(s): bash, edit. Available built-in tools: ipython",
		});
	});
});
