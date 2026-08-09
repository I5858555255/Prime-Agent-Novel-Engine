import type { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type ContextRoutingTelemetryEvent,
	createFastReindexQueue,
	inspectContextRoutingCode,
	installContextRouting,
	SMALL_FILE_BYTES,
} from "../examples/extensions/context-routing.js";
import type { ExtensionAPI } from "../src/core/extensions/index.js";

type CapturedHandler = (event: unknown, ctx?: unknown) => unknown;

function createApi(initialMode: string, initialFastReindex = "on") {
	const handlers = new Map<string, CapturedHandler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	const api = {
		on: (event: string, handler: unknown) => {
			handlers.set(event, handler as CapturedHandler);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => {
			commands.set(name, command);
		},
		registerFlag: vi.fn(),
		getFlag: vi.fn((name: string) => (name === "context-routing-fast-reindex" ? initialFastReindex : initialMode)),
	} as unknown as ExtensionAPI;
	return { api, handlers, commands };
}

function createTempFiles() {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "prime-agent-context-routing-"));
	writeFileSync(path.join(cwd, "large.txt"), "x".repeat(SMALL_FILE_BYTES + 1));
	writeFileSync(path.join(cwd, "small.txt"), "small\n");
	return cwd;
}

describe("context-routing policy", () => {
	it("blocks only high-confidence broad reads", () => {
		const cwd = createTempFiles();
		try {
			expect(inspectContextRoutingCode("%%bash\ncurl https://example.com", cwd).decision).toBe("block");
			expect(inspectContextRoutingCode("%%bash\nwget -qO- https://example.com", cwd).decision).toBe("block");
			expect(inspectContextRoutingCode("%%bash\ncat large.txt", cwd).decision).toBe("block");
			expect(inspectContextRoutingCode('print(open("large.txt").read())', cwd).decision).toBe("block");
			expect(
				inspectContextRoutingCode('from pathlib import Path\nprint(Path("large.txt").read_text())', cwd).decision,
			).toBe("block");
			for (const code of [
				"%%bash\ntail -n +1 large.txt",
				"%%bash\ntail --lines=+5 large.txt",
				"%%bash\nhead +5 large.txt",
				"%%bash\nhead -n+5 large.txt",
			]) {
				expect(inspectContextRoutingCode(code, cwd), code).toMatchObject({ decision: "block" });
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("allows bounded reads, small files, redirects, normal development commands, and fallback paths", () => {
		const cwd = createTempFiles();
		try {
			const allowed = [
				"%%bash\ncurl https://example.com > response.html",
				"%%bash\nwget -O response.html https://example.com",
				"%%bash\ncat large.txt > response.txt",
				"%%bash\ncat large.txt | head -n 20",
				"%%bash\ntail large.txt",
				"%%bash\nhead -5 large.txt",
				"%%bash\ntail -n 5 large.txt",
				"%%bash\nhead -n 5 large.txt",
				"%%bash\ncurl https://example.com | head -c 200",
				"npm test",
				"git status --short",
				"echo generated > output.txt",
				'print(open("large.txt").read(200))',
				'print(Path("large.txt").read_text()[:200])',
				'print(Path("small.txt").read_text())',
				"try:\n    import jcodemunch\nexcept ImportError:\n    print(open('large.txt').read())",
				"# context-routing: bypass\nprint(open('large.txt').read())",
				"%%bash\n# context-routing: bypass\ncat large.txt",
				"%%bash\n# context-routing: fallback\ncat large.txt",
			];
			for (const code of allowed) {
				expect(inspectContextRoutingCode(code, cwd), code).toMatchObject({ decision: "allow" });
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("ignores comments and unknown syntax instead of guessing", () => {
		const cwd = createTempFiles();
		try {
			expect(inspectContextRoutingCode("%%bash\n# cat large.txt\nnpm test", cwd).decision).toBe("allow");
			expect(inspectContextRoutingCode("%%bash\nprintf '%s' 'cat large.txt'", cwd).decision).toBe("allow");
			expect(inspectContextRoutingCode("some_unknown_helper('large.txt')", cwd).decision).toBe("allow");
			expect(inspectContextRoutingCode('print("read_text() is mentioned, not called")', cwd).decision).toBe("allow");
			expect(inspectContextRoutingCode('""" print(open("large.txt").read()) """', cwd).decision).toBe("allow");
			expect(inspectContextRoutingCode("# print(open('large.txt').read())", cwd).decision).toBe("allow");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not treat error words in strings as an unavailable fallback", () => {
		const cwd = createTempFiles();
		try {
			expect(
				inspectContextRoutingCode('print("ImportError; unavailable")\nprint(open("large.txt").read())', cwd)
					.decision,
			).toBe("block");
			expect(
				inspectContextRoutingCode(
					'try:\n    print("ImportError in documentation")\nexcept Exception:\n    print(open("large.txt").read())',
					cwd,
				).decision,
			).toBe("block");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("scopes fallback guards to integration branches and ranges", () => {
		const cwd = createTempFiles();
		try {
			expect(
				inspectContextRoutingCode(
					'try:\n    import unrelated\nexcept ImportError:\n    print(open("large.txt").read())',
					cwd,
				).decision,
			).toBe("block");
			expect(
				inspectContextRoutingCode(
					'try:\n    import jcodemunch\nexcept ImportError:\n    print(open("large.txt").read())\nprint(open("large.txt").read())',
					cwd,
				).decision,
			).toBe("block");
			expect(inspectContextRoutingCode("%%bash\ncommand -v unrelated || cat large.txt", cwd).decision).toBe("block");
			expect(inspectContextRoutingCode("%%bash\ncommand -v jcodemunch || cat large.txt", cwd).decision).toBe(
				"allow",
			);
			expect(
				inspectContextRoutingCode("%%bash\n# context-routing: fallback\ncat large.txt\ncat large.txt", cwd)
					.decision,
			).toBe("block");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects unsafe redirections and only accepts genuinely bounded pipelines", () => {
		const cwd = createTempFiles();
		try {
			const blocked = [
				"%%bash\ncat large.txt >&2",
				"%%bash\ncat large.txt >/dev/stdout",
				"%%bash\ncat large.txt >/dev/stderr",
				"%%bash\ncat large.txt >/dev/stdin",
				"%%bash\ncat large.txt >/dev/fd/0",
				"%%bash\ncat large.txt >/dev/fd/1",
				"%%bash\ncat large.txt >/dev/fd/2",
				"%%bash\ncat large.txt >/dev//fd/1",
				"%%bash\ncat large.txt >/dev//fd/2",
				"%%bash\ncat large.txt >/dev/./fd/1",
				"%%bash\ncat large.txt >/dev/./fd/2",
				"%%bash\ncat large.txt >/dev/fd/../fd/1",
				"%%bash\ncat large.txt >/dev/fd/../fd/2",
				"%%bash\ncat large.txt >//dev/fd/1",
				"%%bash\ncat large.txt >//dev/fd/2",
				"%%bash\ncat large.txt >/proc/self/fd/0",
				"%%bash\ncat large.txt >/proc/self/fd/1",
				"%%bash\ncat large.txt >/proc/self/fd/2",
				"%%bash\ncat large.txt >/proc/thread-self/fd/1",
				"%%bash\ncat large.txt >/proc/thread-self/fd/2",
				"%%bash\ncat large.txt >/proc/12345/fd/1",
				"%%bash\ncat large.txt >/proc/12345/fd/2",
				"%%bash\ncat large.txt >/proc/12345/task/67890/fd/1",
				"%%bash\ncat large.txt >/proc/12345/task/67890/fd/2",
				"%%bash\ncat large.txt >/proc/12345/task/67890/fd/../fd/1",
				"%%bash\ncat large.txt >/proc/thread-self/fd/../fd/2",
				"%%bash\ncat large.txt >/proc/self/root/proc/self/fd/1",
				"%%bash\ncat large.txt >/proc/self/root/proc/self/fd/2",
				"%%bash\ncat large.txt >/proc/self/root/dev/fd/1",
				"%%bash\ncat large.txt >/proc/self/root/dev/fd/2",
				"%%bash\ncat large.txt >/proc/self/cwd/proc/self/fd/1",
				"%%bash\ncat large.txt >/proc/self/cwd/proc/self/fd/2",
				"%%bash\ncat large.txt >/proc/self/cwd/dev/fd/1",
				"%%bash\ncat large.txt >/proc/self/cwd/dev/fd/2",
				"%%bash\ncat large.txt >//proc//self//root//proc//self//fd//1",
				"%%bash\ncat large.txt >//proc//self//root//proc//self//fd//2",
				"%%bash\ncat large.txt >//proc//self//cwd//dev//fd//1",
				"%%bash\ncat large.txt >//proc//self//cwd//dev//fd//2",
				"%%bash\ncat large.txt >/proc/self/root/../root/proc/self/fd/1",
				"%%bash\ncat large.txt >/proc/self/root/../root/proc/self/fd/2",
				"%%bash\ncat large.txt >-",
				"%%bash\ncat large.txt | tail -n +1",
				"%%bash\ncat large.txt | tail --lines=+1",
				"%%bash\ncat large.txt | head -5 | tail -n +1",
				"%%bash\ncat large.txt | head -5 | grep x other.txt",
			];
			for (const code of blocked)
				expect(inspectContextRoutingCode(code, cwd), code).toMatchObject({ decision: "block" });

			const allowed = [
				"%%bash\ncat large.txt >/dev/null",
				"%%bash\ncat large.txt > response.txt",
				"%%bash\ncat large.txt | head -5",
				"%%bash\ncat large.txt | head -n 5",
				"%%bash\ncat large.txt | tail -n 5",
				"%%bash\ncat large.txt | head -5 | cat",
				"%%bash\ncat large.txt | head -5 | grep x",
			];
			for (const code of allowed)
				expect(inspectContextRoutingCode(code, cwd), code).toMatchObject({ decision: "allow" });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("resolves relative redirects against the inspection cwd", () => {
		const cwd = createTempFiles();
		const nestedCwd = "/tmp/prime-agent-context-routing-nested";
		try {
			const rootBlocked = [
				"%%bash\ncat large.txt > proc/self/root/proc/self/fd/1",
				"%%bash\ncurl https://example.com > proc/self/root/proc/self/fd/1",
				"%%bash\ncurl https://example.com -o proc/self/root/proc/self/fd/1",
				"%%bash\ncurl https://example.com > 'proc/self/root/proc/self/fd/2'",
				'%%bash\ncurl https://example.com > "proc/self/cwd/dev/fd/1"',
				"%%bash\ncurl https://example.com > //proc//self//root//proc//self//fd//2",
				"%%bash\ncurl https://example.com > proc/self/cwd/../../root/proc/self/fd/1",
			];
			for (const code of rootBlocked)
				expect(inspectContextRoutingCode(code, "/"), code).toMatchObject({ decision: "block" });

			const nestedBlocked = [
				"%%bash\ncat large.txt > ../../proc/self/fd/1",
				"%%bash\ncurl https://example.com > ../../proc/self/fd/1",
				'%%bash\nwget -O "../../proc/self/fd/2" https://example.com',
				'%%bash\ncurl https://example.com > "../../proc/self/root/dev/fd/2"',
				"%%bash\ncurl https://example.com > ../../proc//self/./root/../root/proc/self/fd/1",
			];
			for (const code of nestedBlocked)
				expect(inspectContextRoutingCode(code, nestedCwd), code).toMatchObject({ decision: "block" });

			const allowed = [
				"%%bash\ncurl https://example.com > response.html",
				'%%bash\ncurl https://example.com > "../response.html"',
			];
			for (const code of allowed)
				expect(inspectContextRoutingCode(code, cwd), code).toMatchObject({ decision: "allow" });
			expect(inspectContextRoutingCode("%%bash\ncurl https://example.com > tmp/response.html", "/").decision).toBe(
				"allow",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("inspects every direct read while allowing scalar reductions", () => {
		const cwd = createTempFiles();
		try {
			const blocked = [
				'print(open("small.txt").read(), open("large.txt").read())',
				'print(open("large.txt").read(200), open("large.txt").read())',
				'print(str(open("large.txt").read()))',
				'print(open("large.txt").read() if flag == "x" else "")',
				'print((flag == "x") and open("large.txt").read())',
				'print(open("large.txt").read() + str(flag == "x"))',
				'print(open("large.txt").read() + ("suffix" if flag == "x" else ""))',
				'print(list([open("large.txt").read()]))',
				'print(min([open("large.txt").read(), "z"]))',
				'print(max((open("large.txt").read(), "z")))',
				'print(tuple(({"content": [open("large.txt").read()]},)))',
				"print(f\"{open('large.txt').read()}\")",
			];
			for (const code of blocked)
				expect(inspectContextRoutingCode(code, cwd), code).toMatchObject({ decision: "block" });

			const allowed = [
				'print(len(open("large.txt").read()))',
				'print(hash(open("large.txt").read()))',
				'print(open("large.txt").read().count("x"))',
				'print(open("large.txt").read() == "x")',
				'print(open("large.txt").read()[:200])',
				'print(len([open("large.txt").read()]))',
				'print(bool({"content": (open("large.txt").read(),)}))',
				'print(hash(tuple([open("large.txt").read()])))',
				"print(f\"{len(open('large.txt').read())}\")",
			];
			for (const code of allowed)
				expect(inspectContextRoutingCode(code, cwd), code).toMatchObject({ decision: "allow" });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("injects advisory guidance per turn and blocks strict cells with telemetry", async () => {
		const events: ContextRoutingTelemetryEvent[] = [];
		const { api, handlers, commands } = createApi("strict-large-read");
		const stats = installContextRouting(api, { telemetry: (event) => events.push(event) });
		const beforeAgentStart = handlers.get("before_agent_start");
		const toolCall = handlers.get("tool_call");
		expect(beforeAgentStart).toBeDefined();
		expect(toolCall).toBeDefined();

		const prompt = (await beforeAgentStart?.({ systemPrompt: "base" })) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("jCodeMunch");
		expect(prompt.systemPrompt).toContain("Context Mode");
		expect(prompt.systemPrompt).toContain("routing guidance, not security");

		const result = await toolCall?.(
			{ toolName: "ipython", input: { code: "%%bash\ncurl https://example.com" } },
			{ cwd: process.cwd() },
		);
		expect(result).toMatchObject({ block: true });
		expect(stats).toMatchObject({ turnsGuided: 1, cellsInspected: 1, blocked: 1 });
		expect(events).toEqual([
			{ kind: "turn-guidance", mode: "strict-large-read", action: "advisory" },
			{ kind: "inspection", mode: "strict-large-read", action: "block", pattern: "curl/wget stdout" },
		]);
		expect(commands.has("context-routing")).toBe(true);
	});

	it("supports advisory mode and runtime mode changes", async () => {
		const { api, handlers, commands } = createApi("advisory");
		installContextRouting(api);
		const prompt = (await handlers.get("before_agent_start")?.({ systemPrompt: "base" })) as { systemPrompt: string };
		expect(prompt.systemPrompt).toContain("Context routing (advisory)");
		expect(
			await handlers.get("tool_call")?.(
				{ toolName: "ipython", input: { code: "%%bash\ncurl https://example.com" } },
				{ cwd: process.cwd() },
			),
		).toBeUndefined();

		const ui = { notify: vi.fn() };
		await commands.get("context-routing")?.handler("strict-large-read", { ui });
		expect(
			await handlers.get("tool_call")?.(
				{ toolName: "ipython", input: { code: "%%bash\ncurl https://example.com" } },
				{ cwd: process.cwd() },
			),
		).toMatchObject({ block: true });
		await commands.get("context-routing")?.handler("off", { ui });
		expect(
			await handlers.get("tool_call")?.(
				{ toolName: "ipython", input: { code: "%%bash\ncurl https://example.com" } },
				{ cwd: process.cwd() },
			),
		).toBeUndefined();
	});

	it("does not inject or inspect in off mode", async () => {
		const { api, handlers } = createApi("off");
		const stats = installContextRouting(api);
		expect(await handlers.get("before_agent_start")?.({ systemPrompt: "base" })).toBeUndefined();
		expect(
			await handlers.get("tool_call")?.(
				{ toolName: "ipython", input: { code: "%%bash\ncat large.txt" } },
				{ cwd: process.cwd() },
			),
		).toBeUndefined();
		expect(stats).toEqual({ turnsGuided: 0, cellsInspected: 0, allowed: 0, blocked: 0 });
	});

	it("queues only successful IPython edit diffs and skips unsafe paths", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "prime-agent-context-routing-reindex-"));
		try {
			const sourceDir = path.join(cwd, "src");
			mkdirSync(sourceDir);
			const changedPath = path.join(sourceDir, "changed.ts");
			const generatedPath = path.join(sourceDir, "models.generated.ts");
			const directoryPath = path.join(sourceDir, "directory");
			const deletedPath = path.join(sourceDir, "deleted.ts");
			writeFileSync(changedPath, "changed\n");
			writeFileSync(generatedPath, "generated\n");
			mkdirSync(directoryPath);
			const calls: string[] = [];
			const { api, handlers } = createApi("off");
			installContextRouting(api, {
				reindexFile: (absolutePath) => {
					calls.push(absolutePath);
				},
			});
			const toolResult = handlers.get("tool_result");

			await toolResult?.(
				{
					toolName: "ipython",
					isError: false,
					details: {
						status: "ok",
						diffs: [
							{ path: changedPath },
							{ path: path.relative(cwd, changedPath) },
							{ path: generatedPath },
							{ path: directoryPath },
							{ path: deletedPath },
						],
					},
				},
				{ cwd },
			);
			await toolResult?.(
				{ toolName: "ipython", isError: true, details: { status: "error", diffs: [{ path: changedPath }] } },
				{ cwd },
			);

			expect(calls).toEqual([changedPath]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("honors the fast-reindex off switch", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "prime-agent-context-routing-reindex-off-"));
		try {
			const changedPath = path.join(cwd, "changed.ts");
			writeFileSync(changedPath, "changed\n");
			const calls: string[] = [];
			const { api, handlers } = createApi("off", "off");
			installContextRouting(api, {
				reindexFile: (absolutePath) => {
					calls.push(absolutePath);
				},
			});
			await handlers.get("tool_result")?.(
				{ toolName: "ipython", isError: false, details: { status: "ok", diffs: [{ path: changedPath }] } },
				{ cwd },
			);
			expect(calls).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("coalesces duplicate paths and bounds concurrent reindexes", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "prime-agent-context-routing-queue-"));
		try {
			const paths = ["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => path.join(cwd, name));
			for (const filePath of paths) writeFileSync(filePath, `${filePath}\n`);
			let active = 0;
			let maximumActive = 0;
			const calls: string[] = [];
			const queue = createFastReindexQueue({
				concurrency: 2,
				reindexFile: async (absolutePath) => {
					calls.push(absolutePath);
					active += 1;
					maximumActive = Math.max(maximumActive, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					active -= 1;
				},
			});
			queue.enqueue([...paths, paths[0]!], cwd);
			queue.enqueue([paths[1]!], cwd);
			await queue.whenIdle();

			expect(calls).toHaveLength(paths.length);
			expect(new Set(calls)).toEqual(new Set(paths));
			expect(maximumActive).toBe(2);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("runs the CLI without a shell or inherited secret environment", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "prime-agent-context-routing-cli-"));
		try {
			const changedPath = path.join(cwd, "changed.ts");
			writeFileSync(changedPath, "changed\n");
			const child = { once: vi.fn() } as unknown as ChildProcess;
			const spawnMock = vi.fn((_command: string, _args: readonly string[], _options: object) => child);
			const queue = createFastReindexQueue({ spawnProcess: spawnMock as unknown as typeof spawn });
			queue.enqueue([changedPath], cwd);
			const closeListener = (child.once as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
				([event]) => event === "close",
			)?.[1] as (() => void) | undefined;
			closeListener?.();
			await queue.whenIdle();

			expect(spawnMock).toHaveBeenCalledWith(
				"jcodemunch-mcp",
				["index-file", "--no-ai-summaries", changedPath],
				expect.objectContaining({ shell: false, stdio: "ignore" }),
			);
			const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
			expect(spawnOptions?.env).not.toHaveProperty("OPENAI_API_KEY");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
