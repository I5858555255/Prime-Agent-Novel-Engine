import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliMocks = vi.hoisted(() => ({
	agentOptions: [] as Array<Record<string, unknown>>,
	closeOwnedSessionWorkerOwnerWatch: vi.fn(),
	installOwnedSessionWorkerOwnerWatch: vi.fn(),
	main: vi.fn(async () => {}),
	maybeRunOwnedSessionWorkerFrontend: vi.fn(async () => false),
	maybeStartDaemonEarly: vi.fn(),
	setGlobalDispatcher: vi.fn(),
}));

vi.mock("undici", () => ({
	EnvHttpProxyAgent: class EnvHttpProxyAgent {
		constructor(options: Record<string, unknown>) {
			cliMocks.agentOptions.push(options);
		}
	},
	setGlobalDispatcher: cliMocks.setGlobalDispatcher,
}));

vi.mock("../src/cli/daemon-launch.js", () => ({
	maybeStartDaemonEarly: cliMocks.maybeStartDaemonEarly,
}));

vi.mock("../src/cli/owned-session-worker.js", () => ({
	closeOwnedSessionWorkerOwnerWatch: cliMocks.closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch: cliMocks.installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess: () => false,
	maybeRunOwnedSessionWorkerFrontend: cliMocks.maybeRunOwnedSessionWorkerFrontend,
}));

vi.mock("../src/main.js", () => ({
	main: cliMocks.main,
}));

import { runCli as runCliMain } from "../src/cli-main.js";
import { ENV_AGENT_DIR } from "../src/config.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCliProcess(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const projectConfigDir = join(projectDir, ".prime", "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });

	const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
	writeFileSync(
		fakeNpmPath,
		[
			'console.log("changed 1 package in 471ms");',
			'console.log("found 0 vulnerabilities");',
			"process.exit(0);",
		].join("\n"),
		"utf-8",
	);

	writeFileSync(
		join(projectConfigDir, "settings.json"),
		JSON.stringify(
			{
				packages: ["npm:fake-package"],
				npmCommand: [process.execPath, fakeNpmPath],
			},
			null,
			2,
		),
		"utf-8",
	);

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("stdout cleanliness in non-interactive modes", () => {
	it("keeps stdout empty for --mode json --help without starting runtime packages", async () => {
		const result = await runCliProcess(["--mode", "json", "--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("changed 1 package in 471ms");
		expect(result.stderr).not.toContain("found 0 vulnerabilities");
		expect(result.stderr).toContain("Usage:");
		expect(result.stderr).toContain("Options:");
		expect(result.stderr).toContain("Commands:");
		expect(result.stderr).not.toContain("Environment Variables:");
	});

	it("keeps stdout empty for -p -h without starting runtime packages", async () => {
		const result = await runCliProcess(["-p", "-h"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("changed 1 package in 471ms");
		expect(result.stderr).not.toContain("found 0 vulnerabilities");
		expect(result.stderr).toContain("Usage:");
		expect(result.stderr).not.toContain("Examples:");
		expect(result.stderr).not.toContain("Built-in Tool Names:");
	});
});

describe("CLI proxy dispatcher", () => {
	const originalArgv = process.argv;
	const originalEmitWarning = process.emitWarning;
	const originalPiCodingAgent = process.env.PI_CODING_AGENT;
	const originalTitle = process.title;

	beforeEach(() => {
		cliMocks.agentOptions.length = 0;
		vi.clearAllMocks();
		process.argv = ["node", "pi"];
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.emitWarning = originalEmitWarning;
		process.title = originalTitle;
		if (originalPiCodingAgent === undefined) {
			delete process.env.PI_CODING_AGENT;
		} else {
			process.env.PI_CODING_AGENT = originalPiCodingAgent;
		}
	});

	it("installs an unlimited-timeout environment proxy dispatcher before main", async () => {
		await runCliMain();

		expect(cliMocks.agentOptions).toEqual([{ bodyTimeout: 0, headersTimeout: 0 }]);
		expect(cliMocks.setGlobalDispatcher).toHaveBeenCalledTimes(1);
		expect(cliMocks.setGlobalDispatcher.mock.invocationCallOrder[0]).toBeLessThan(
			cliMocks.main.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(cliMocks.main).toHaveBeenCalledWith([]);
		expect(cliMocks.closeOwnedSessionWorkerOwnerWatch).toHaveBeenCalledTimes(1);
	});
});
