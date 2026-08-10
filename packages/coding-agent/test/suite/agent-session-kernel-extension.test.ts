import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExecuteResult } from "../../src/core/kernel/index.js";
import type { ExtensionAPI } from "../../src/index.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

/** Find a python that can launch an ipykernel with the rlm runtime, or null to skip. */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel, rlm"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

/**
 * Extension access to the session IPython kernel via `pi.kernel.execute()`.
 *
 * Exercises the real kernel (same one the built-in ipython tool uses), so the
 * suite requires a bootstrapped kernel venv and skips otherwise.
 */
describeIfKernel("pi.kernel extension API (real kernel)", { tags: ["kernel-heavy"] }, () => {
	const harnesses: Harness[] = [];
	let originalKernelPython: string | undefined;

	beforeAll(() => {
		originalKernelPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
		process.env.PRIME_AGENT_KERNEL_PYTHON = python as string;
	});

	afterAll(() => {
		if (originalKernelPython === undefined) {
			delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		} else {
			process.env.PRIME_AGENT_KERNEL_PYTHON = originalKernelPython;
		}
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function captureKernelCalls(): {
		results: ExecuteResult[];
		errors: unknown[];
		factory: (pi: ExtensionAPI) => void;
	} {
		const results: ExecuteResult[] = [];
		const errors: unknown[] = [];
		return {
			results,
			errors,
			factory: (pi) => {
				pi.on("session_start", async () => {
					try {
						results.push(await pi.kernel.execute("print(2 + 2)"));
					} catch (error) {
						errors.push(error);
					}
				});
			},
		};
	}

	it("executes code in the session kernel from an extension", async () => {
		const { results, errors, factory } = captureKernelCalls();
		const harness = await createHarness({ extensionFactories: [factory] });
		harnesses.push(harness);

		await harness.session.bindExtensions({});

		expect(errors).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0].status).toBe("ok");
		expect(results[0].stdout).toContain("4");
	});

	it("keeps kernel state across extension calls", async () => {
		const results: ExecuteResult[] = [];
		const errors: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						try {
							results.push(await pi.kernel.execute("answer = 6 * 7"));
							results.push(await pi.kernel.execute("print(answer)"));
						} catch (error) {
							errors.push(error);
						}
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});

		expect(errors).toEqual([]);
		expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
		expect(results[1].stdout).toContain("42");
	});

	it("shares kernel state with the built-in ipython tool", async () => {
		const errors: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						try {
							await pi.kernel.execute("answer = 42");
						} catch (error) {
							errors.push(error);
						}
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});
		expect(errors).toEqual([]);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ipython", { code: "print(answer)" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("print answer in python");

		const toolResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "ipython",
		);
		expect(toolResult).toBeDefined();
		expect(getMessageText(toolResult)).toContain("42");
	});

	it("reports kernel errors in the result instead of rejecting host-side", async () => {
		let result: ExecuteResult | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						result = await pi.kernel.execute('raise ValueError("boom")');
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});

		expect(result?.status).toBe("error");
		expect(result?.error?.ename).toBe("ValueError");
		expect(result?.error?.evalue).toContain("boom");
	});

	it("honors maxOutputChars truncation", async () => {
		let result: ExecuteResult | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						result = await pi.kernel.execute('print("x" * 10000)', { maxOutputChars: 100 });
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});

		expect(result?.status).toBe("ok");
		expect(result?.stdout.length).toBeLessThanOrEqual(200);
		expect(result?.stdout).toContain("output truncated");
	});
});
