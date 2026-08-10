import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { buildRlmBootstrapCode } from "../src/core/tools/ipython.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describe("IPython %%bash interrupt handling unit tests", () => {
	it("includes the ScriptMagics shebang process-group wrapper in the bootstrap code", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain("_PrimeAgentScriptMagics.shebang = _prime_agent_wrapped_shebang");
		expect(code).toContain("_prime_agent_pgroup_popen");
		expect(code).toContain("KeyboardInterrupt");
	});
});

describeIfKernel("IPython %%bash interrupt handling (real kernel)", () => {
	it("kills child process group when execution is interrupted", async () => {
		const manager = new KernelManager({ python: python as string, cwd: process.cwd() });
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const controller = new AbortController();
			const execPromise = manager.execute("%%bash\nsleep 60", { signal: controller.signal });

			// Give bash a moment to spawn the sleep child process
			await new Promise((r) => setTimeout(r, 300));
			controller.abort();

			const result = await execPromise;
			expect(result.status).toBe("aborted");
		} finally {
			await manager.dispose();
		}
	}, 30_000);
});
