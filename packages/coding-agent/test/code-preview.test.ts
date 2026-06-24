import { describe, expect, it } from "vitest";
import { previewBashCommand, previewIpythonCode, previewPythonCode } from "../src/core/tools/code-preview.js";

describe("code preview", () => {
	it("skips bash setup and previews the real command", () => {
		expect(previewBashCommand("set -e\nnpm run check")).toEqual({ language: "bash", text: "npm check" });
	});

	it("simplifies common runner wrappers", () => {
		expect(
			previewBashCommand("npx tsx ../../node_modules/vitest/dist/cli.js --run test/code-preview.test.ts"),
		).toEqual({
			language: "bash",
			text: "vitest --run test/code-preview.test.ts",
		});
	});

	it("unwraps python heredocs in bash", () => {
		const command = `set -e
python3 - <<'PY'
from pathlib import Path
path = Path("package.json")
text = path.read_text()
path.write_text(text)
PY`;
		expect(previewBashCommand(command)).toEqual({ language: "python", text: "path.write_text(text)" });
	});

	it("unwraps bash cells in ipython", () => {
		const code = `%%bash
set -e
python3 - <<'PY'
import json
data = json.loads("{}")
print(data.keys())
PY`;
		expect(previewIpythonCode(code)).toEqual({ language: "python", text: "data.keys()" });
	});

	it("prefers meaningful python effects over setup assignments", () => {
		const code = `from pathlib import Path
p = Path("packages/coding-agent/src/modes/interactive/components/ipython-cell.ts")
txt = p.read_text()
p.write_text(txt.replace("old", "new"))`;
		expect(previewPythonCode(code)).toEqual({
			language: "python",
			text: "write packages/coding-agent/src/modes/interactive/components/ip…",
		});
	});

	it("handles stronger bash heuristics", () => {
		expect(previewBashCommand("cd packages/coding-agent && npm --prefix ../.. run check")).toEqual({
			language: "bash",
			text: "npm check (../..)",
		});
		expect(previewBashCommand("echo setup\ngit add packages/foo.ts")).toEqual({
			language: "bash",
			text: "git add packages/foo.ts",
		});
		expect(previewBashCommand("cat > packages/foo.ts <<'EOF'\nhello\nEOF")).toEqual({
			language: "bash",
			text: "write packages/foo.ts",
		});
	});

	it("extracts python subprocesses and control-block effects", () => {
		const subprocessCode = `import subprocess
subprocess.run(["npm", "run", "check"])
`;
		expect(previewPythonCode(subprocessCode)).toEqual({ language: "python", text: "npm check" });

		const controlCode = `from pathlib import Path
p = Path("packages/foo.ts")
if p.exists():
    p.unlink()
`;
		expect(previewPythonCode(controlCode)).toEqual({ language: "python", text: "delete packages/foo.ts" });
	});

	it("prefers executable calls over helper definitions", () => {
		const code = `def helper():
    return 1
run_check()
`;
		expect(previewPythonCode(code)).toEqual({ language: "python", text: "run_check()" });
	});
});
