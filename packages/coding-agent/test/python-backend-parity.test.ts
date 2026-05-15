import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PythonExecutionBackend } from "../src/core/python-backend/types.js";
import { createIpythonToolDefinition, type IpythonToolDetails } from "../src/core/tools/ipython.js";

const BACKENDS = ["jupyter-zmq", "prime-worker"] as const;

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let activeBackendRefs: Array<{ current?: PythonExecutionBackend }> = [];

function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
}

function makeTool() {
	const kernelManagerRef: { current?: PythonExecutionBackend } = {};
	activeBackendRefs.push(kernelManagerRef);
	return createIpythonToolDefinition(tempDir, {
		kernelManagerRef,
		rlmRunHandler: async ({ prompt }) => ({
			answer: `answer:${prompt}`,
			usage: { prompt_tokens: prompt.length, completion_tokens: 3 },
			turns: 2,
			session_dir: join(tempDir, "child-session"),
		}),
		rlmBackgroundRunHandler: async ({ prompt }) => ({
			id: `bg:${prompt}`,
			state: "running",
			session_dir: join(tempDir, "background-session"),
		}),
		rlmBackgroundStatusHandler: async ({ id }) => ({
			id,
			state: "running",
			session_dir: join(tempDir, "background-session"),
		}),
		rlmBackgroundWaitHandler: async ({ id }) => ({
			id,
			state: "done",
			session_dir: join(tempDir, "background-session"),
			result: {
				answer: `background:${id}`,
				usage: { prompt_tokens: 5, completion_tokens: 7 },
				turns: 1,
				session_dir: join(tempDir, "background-child-session"),
			},
		}),
	});
}

async function execute(
	tool: ReturnType<typeof makeTool>,
	code: string,
	signal?: AbortSignal,
): Promise<{ text: string; details: IpythonToolDetails; isError?: boolean }> {
	const ctx = {} as Parameters<typeof tool.execute>[4];
	const result = await tool.execute("test", { code }, signal, undefined, ctx);
	const isError = "isError" in result && typeof result.isError === "boolean" ? result.isError : undefined;
	return {
		text: contentText(result),
		details: result.details,
		isError,
	};
}

describe("Python backend parity", () => {
	afterEach(async () => {
		await Promise.allSettled(activeBackendRefs.map((ref) => ref.current?.dispose()));
		activeBackendRefs = [];
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	for (const backend of BACKENDS) {
		describe(backend, () => {
			beforeEach(() => {
				originalEnv = { ...process.env };
				tempDir = mkdtempSync(join(tmpdir(), `prime-agent-${backend}-`));
				process.env.PRIME_AGENT_PYTHON_BACKEND = backend;
				process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");
			});

			it("executes IPython cells and preserves session lifecycle", async () => {
				const tool = makeTool();

				await execute(tool, "import math\nx = math.sqrt(1764)");
				await expect(execute(tool, "print(int(x))")).resolves.toMatchObject({ text: "42\n" });
				await expect(execute(tool, "6 * 7")).resolves.toMatchObject({ text: "42" });

				const pwd = await execute(tool, "!pwd");
				expect(pwd.text.trim()).toBe(realpathSync(tempDir));
				await expect(execute(tool, "%%bash\necho bash-ok")).resolves.toMatchObject({ text: "bash-ok\n" });
				await expect(
					execute(tool, 'import asyncio\nawait asyncio.sleep(0)\nprint("await-ok")'),
				).resolves.toMatchObject({ text: "await-ok\n" });
				const subprocess = await execute(
					tool,
					'import subprocess, sys\nsubprocess.run([sys.executable, "-c", "print(\'subprocess-ok\')"], check=True)',
				);
				expect(subprocess.text).toContain("subprocess-ok");
				const stdin = await execute(
					tool,
					[
						"try:",
						'    input("blocked")',
						"except Exception as error:",
						'    print("stdin-blocked", type(error).__name__)',
						"import subprocess, sys",
						"subprocess.run([sys.executable, \"-c\", \"import sys; print('stdin-empty', sys.stdin.read() == '')\"], check=True)",
					].join("\n"),
				);
				expect(stdin.text).toContain("stdin-blocked");
				expect(stdin.text).toContain("stdin-empty True");

				const streams = await execute(tool, 'import sys\nprint("out")\nprint("err", file=sys.stderr)');
				expect(streams.text).toContain("out");
				expect(streams.text).toContain("err");

				const error = await execute(tool, 'raise ValueError("bad-value")');
				expect(error.isError).toBe(true);
				expect(error.details.status).toBe("error");
				expect(error.details.errorEname).toBe("ValueError");
				expect(error.text).toContain("bad-value");

				const longOutput = await execute(tool, 'print("x" * 70000)');
				expect(longOutput.text).toContain("[... output truncated at 65536 chars ...]");
				const longResult = await execute(tool, '"x" * 70000');
				expect(longResult.text).toContain("[... output truncated at 65536 chars ...]");
				expect(longResult.text.length).toBeLessThan(66000);
			}, 120_000);

			it("restarts with a clean namespace", async () => {
				const kernelManagerRef: { current?: PythonExecutionBackend } = {};
				activeBackendRefs.push(kernelManagerRef);
				const tool = createIpythonToolDefinition(tempDir, { kernelManagerRef });

				await execute(tool, "x = 1");
				await kernelManagerRef.current?.restart();

				const result = await execute(tool, 'print("x" in globals())');
				expect(result.text).toBe("False\n");
			}, 120_000);

			it("round-trips foreground and background RLM requests", async () => {
				const tool = makeTool();

				const foreground = await execute(
					tool,
					[
						"import asyncio",
						"import rlm as rlm_module",
						'results = await asyncio.gather(rlm("one"), rlm.run("two", temperature=0))',
						'module_result = await rlm_module("three")',
						"print([r.answer for r in results])",
						"print(module_result.answer)",
						"print(results[0].usage.prompt_tokens)",
					].join("\n"),
				);
				expect(foreground.text).toContain("answer:one");
				expect(foreground.text).toContain("answer:two");
				expect(foreground.text).toContain("3");

				const background = await execute(
					tool,
					[
						'h = await rlm.background("job", notify="silent")',
						"print(h.id)",
						"s = await h.status()",
						"print(s.state)",
						"r = await h.result(timeout=1)",
						"print(r.answer)",
						"s2 = await h.wait()",
						"print(s2.state)",
						"r2 = await h.result()",
						"print(r2.answer)",
					].join("\n"),
				);
				expect(background.text).toContain("bg:job");
				expect(background.text).toContain("running");
				expect(background.text).toContain("background:bg:job");
			}, 120_000);

			it("aborts long-running code and remains usable", async () => {
				const tool = makeTool();
				const controller = new AbortController();
				const pending = execute(tool, "import time\ntime.sleep(10)", controller.signal);

				globalThis.setTimeout(() => controller.abort(), 100);

				const aborted = await pending;
				expect(aborted.isError).toBe(true);
				expect(aborted.details.status).toBe("aborted");

				const recovered = await execute(tool, 'print("alive")');
				expect(recovered.text).toBe("alive\n");
			}, 120_000);
		});
	}
});
