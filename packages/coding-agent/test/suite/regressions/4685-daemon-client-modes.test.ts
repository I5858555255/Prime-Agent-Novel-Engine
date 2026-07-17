import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../../src/cli/subprocess-launch.js";
import type { AutonomousRuntimeState } from "../../../src/core/autonomous.js";
import { waitForHeadlessCompletion } from "../../../src/modes/headless-completion.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

const fixturePath = resolve(__dirname, "../../fixtures/rpc-connection-mode-fixture.ts");
const tsxPath = resolve(__dirname, "../../../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../../../tsconfig.json");
const children = new Set<ChildProcess>();
const harnesses: Harness[] = [];

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

async function runRpc(commands: object[]): Promise<{ stdout: object[]; stderr: string }> {
	const child = spawn(process.execPath, [tsxPath, fixturePath], {
		env: { ...process.env, TSX_TSCONFIG_PATH: repoTsconfigPath },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdin?.end(`${commands.map((command) => JSON.stringify(command)).join("\n")}\n`);
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
		const timeout = setTimeout(() => reject(new Error(`RPC fixture timed out\n${stderr}`)), 10_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal: signal as NodeJS.Signals | null });
		});
	});
	children.delete(child);
	expect(exit).toEqual({ code: 0, signal: null });
	return {
		stdout: stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as object),
		stderr,
	};
}

describe("ENG-4685 daemon-backed client modes", () => {
	it("runs host-owned autonomous gate retries through the shared completion loop", async () => {
		const gate = `${process.execPath} -e "process.exit(0)"`;
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				gates: { commands: [gate], maxRetries: 2 },
			},
		});
		harnesses.push(harness);
		const state = (
			harness.session as unknown as {
				_autonomousState: AutonomousRuntimeState;
			}
		)._autonomousState;
		state.gateAttempts[gate] = 1;
		state.lastGateFailure = {
			command: gate,
			attempt: 1,
			exitText: "exited 1",
			output: "gate failed",
		};
		harness.setResponses([fauxAssistantMessage("I fixed the gate failure.")]);

		const status = await waitForHeadlessCompletion(harness.session);

		expect(getUserTexts(harness)).toHaveLength(1);
		expect(getUserTexts(harness)[0]).toContain("Autonomous quality gate failed");
		expect(getAssistantTexts(harness)).toEqual(["I fixed the gate failure."]);
		expect(status).toMatchObject({
			continuationsUsed: 1,
			lastGateFailure: undefined,
		});
	});

	it("resolves source subprocesses independently of a spaced runtime cwd", () => {
		const entrypoint = resolve(__dirname, "../../../src/cli.ts");
		const launch = createCliSubprocessLaunchSpec([], process.execPath, [], "packages/coding-agent/src/cli.ts");
		const environment = createCliSubprocessEnv({}, entrypoint, ["--import", "tsx"]);

		expect(launch.args[0]).toBe(resolve("packages/coding-agent/src/cli.ts"));
		expect(environment.TSX_TSCONFIG_PATH).toBe(repoTsconfigPath);
	});

	it("drains accepted RPC commands before EOF releases the connection", async () => {
		const result = await runRpc([{ id: "models", type: "get_available_models" }]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{
				id: "models",
				type: "response",
				command: "get_available_models",
				success: true,
				data: { models: [] },
			},
		]);
	});

	it("preserves prompt acknowledgements before events and repeated prompts", async () => {
		const result = await runRpc([
			{ id: "prompt-1", type: "prompt", message: "one" },
			{ id: "prompt-2", type: "prompt", message: "two" },
		]);
		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual([
			{ id: "prompt-1", type: "response", command: "prompt", success: true },
			{ type: "agent_start" },
			{ id: "prompt-2", type: "response", command: "prompt", success: true },
			{ type: "agent_start" },
		]);
	});

	it("exposes daemon schedules, heartbeats, messaging, and observation", async () => {
		const result = await runRpc([
			{ id: "schedules", type: "list_schedules" },
			{ id: "heartbeats", type: "list_heartbeats" },
			{ id: "status", type: "agent_messages_status" },
			{ id: "message", type: "send_message", targetActiveSessionId: "child", message: "check in" },
			{ id: "observe", type: "observe", activeSessionId: "child" },
		]);

		expect(result.stderr).toBe("");
		expect(result.stdout).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "schedules",
					success: true,
					data: expect.objectContaining({ jobs: expect.arrayContaining([expect.any(Object)]) }),
				}),
				expect.objectContaining({
					id: "heartbeats",
					success: true,
					data: expect.objectContaining({ heartbeats: expect.arrayContaining([expect.any(Object)]) }),
				}),
				expect.objectContaining({
					id: "status",
					success: true,
					data: expect.objectContaining({ paused: false }),
				}),
				expect.objectContaining({
					id: "message",
					success: true,
					data: expect.objectContaining({ deliveryStatus: "delivered" }),
				}),
				expect.objectContaining({
					id: "observe",
					success: true,
					data: expect.objectContaining({ messages: expect.arrayContaining([expect.any(Object)]) }),
				}),
				{
					type: "observed_session_event",
					activeSessionId: "child",
					event: { type: "agent_start" },
				},
			]),
		);
	});
});
