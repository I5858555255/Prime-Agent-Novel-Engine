import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, PACKAGE_NAME } from "../src/config.js";
import { handlePackageCommand } from "../src/package-manager-cli.js";

interface MockSessionSummary {
	id: string;
	activeSessionId?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	pendingMessageCount: number;
}

type MockRunningDaemonProbe = { reachable: false } | { reachable: true; activeSessions?: MockSessionSummary[] };

const daemonManifest = {
	createdAt: "2026-07-07T00:00:00.000Z",
	sessions: [],
};

const mockState = vi.hoisted(() => ({
	calls: [] as string[],
	daemonProbe: { reachable: true, activeSessions: [] } as MockRunningDaemonProbe,
	globalPackageRoot: "",
	socketPath: "",
	spawnExitCodes: [] as number[],
	shutdownResult: true,
}));

vi.mock("child_process", () => ({
	spawn: vi.fn((command: string, args: string[]) => {
		mockState.calls.push(`spawn:${command} ${args.join(" ")}`);
		const exitCode = mockState.spawnExitCodes.shift() ?? 0;
		const child = {
			on(event: string, listener: unknown) {
				if (event === "close") {
					queueMicrotask(() => {
						(listener as (code: number | null, signal: string | null) => void)(exitCode, null);
					});
				}
				return child;
			},
		};
		return child;
	}),
	spawnSync: vi.fn(() => ({
		status: 0,
		stdout: `${mockState.globalPackageRoot}\n`,
		stderr: "",
	})),
}));

vi.mock("../src/modes/daemon/daemon-socket.js", () => ({
	defaultDaemonSocketPath: () => mockState.socketPath,
}));

vi.mock("../src/cli/daemon-launch.js", () => ({
	ensureInteractiveDaemonRunning: vi.fn(async () => {
		mockState.calls.push("ensure-daemon");
	}),
	isDaemonSessionSummary: (value: unknown) => {
		if (!value || typeof value !== "object") {
			return false;
		}
		const summary = value as { activeSessionId?: unknown; id?: unknown };
		return typeof summary.activeSessionId === "string" || typeof summary.id === "string";
	},
	isSessionBusy: (summary: MockSessionSummary) =>
		summary.isStreaming ||
		summary.isCompacting ||
		summary.isBashRunning === true ||
		summary.hasRunningRlmChildren === true ||
		summary.pendingMessageCount > 0,
	probeRunningDaemonSessions: vi.fn(async () => {
		mockState.calls.push("probe-daemon");
		return mockState.daemonProbe;
	}),
	shutdownDaemonAndWait: vi.fn(async () => {
		mockState.calls.push("shutdown-daemon");
		return mockState.shutdownResult;
	}),
}));

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: class {
		constructor(readonly socketPath: string) {}

		async connect(): Promise<void> {
			mockState.calls.push(`daemon-connect:${this.socketPath}`);
		}

		async request(request: { type: string }): Promise<{ success: true; data?: unknown }> {
			mockState.calls.push(`daemon-request:${request.type}`);
			return { success: true, data: request.type === "prepare_update_restart" ? daemonManifest : undefined };
		}

		close(): void {}
	},
}));

describe("self-update daemon restart", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalCwd: string;
	let originalExecPath: string;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-self-update-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "global-prefix", "lib", "node_modules", PACKAGE_NAME);
		mockState.globalPackageRoot = join(tempDir, "global-prefix", "lib", "node_modules");
		mockState.socketPath = join(tempDir, "daemon.sock");
		mockState.calls = [];
		mockState.daemonProbe = { reachable: true, activeSessions: [] };
		mockState.spawnExitCodes = [];
		mockState.shutdownResult = true;
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalCwd = process.cwd();
		originalExecPath = process.execPath;
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PI_PACKAGE_DIR = packageDir;
		process.chdir(projectDir);
		Object.defineProperty(process, "execPath", {
			value: join(packageDir, "dist", "cli.js"),
			configurable: true,
		});
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["npm"] }, null, 2));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "999.0.0" })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not prepare or stop the daemon when the package update fails", async () => {
		mockState.spawnExitCodes = [23];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls).toContain("probe-daemon");
			expect(mockState.calls.some((call) => call === "daemon-request:prepare_update_restart")).toBe(false);
			expect(mockState.calls.some((call) => call === "shutdown-daemon")).toBe(false);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("restarts the daemon only after the package update succeeds", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBeUndefined();
			const spawnIndex = mockState.calls.findIndex((call) => call.startsWith("spawn:npm "));
			const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
			const shutdownIndex = mockState.calls.indexOf("shutdown-daemon");
			const ensureIndex = mockState.calls.indexOf("ensure-daemon");
			expect(spawnIndex).toBeGreaterThanOrEqual(0);
			expect(prepareIndex).toBeGreaterThan(spawnIndex);
			expect(shutdownIndex).toBeGreaterThan(prepareIndex);
			expect(ensureIndex).toBeGreaterThan(shutdownIndex);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
