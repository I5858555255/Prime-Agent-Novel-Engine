/**
 * Standalone test of the production `ipython` tool. Exercises the same code
 * path as the model-driven flow but skips the LLM — just constructs the tool,
 * calls execute() directly, and verifies behavior.
 */
import { createIpythonTool } from "../packages/coding-agent/src/core/tools/ipython.js";
import { resolveKernelPython } from "../packages/coding-agent/src/core/kernel/index.js";

const python = resolveKernelPython();
console.log(`resolved python: ${python}`);
if (!python) {
	console.error("FAIL: no Python kernel resolvable");
	process.exit(1);
}

const tool = createIpythonTool(process.cwd());

async function call(code: string): Promise<void> {
	console.log(`\n--- code ---\n${code}`);
	const r = await tool.execute("test-id", { code }, undefined, undefined);
	const out = r.content[0] as { type: "text"; text: string };
	console.log(`stdout: ${JSON.stringify(out.text)}`);
	console.log(`details:`, r.details);
	if (r.isError) console.log(`isError: true`);
}

await call(`print("hello"); x = 42`);
await call(`print(x * 2)`);
await call(`import sys; print(sys.version_info[:2])`);
await call(`!echo "shell from kernel via bang-cmd"`);
await call(`raise ValueError("boom")`);

console.log("\nall calls completed");
process.exit(0);
