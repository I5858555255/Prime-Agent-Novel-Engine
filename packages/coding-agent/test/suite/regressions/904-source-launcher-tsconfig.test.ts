import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("issue #904 source launcher tsconfig", () => {
	it("passes --tsconfig to tsx in prime-agent.sh", () => {
		const scriptPath = resolve(__dirname, "../../../../../prime-agent.sh");
		const content = readFileSync(scriptPath, "utf-8");

		expect(content).toContain(
			'"$TSX_BIN" --tsconfig "$SCRIPT_DIR/tsconfig.json" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts"',
		);
	});
});
