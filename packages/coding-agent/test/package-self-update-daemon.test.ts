import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DaemonUpdateRestartModule from "../src/cli/daemon-update-restart.js";
import {
	acquireDaemonUpdateRestartCoordinator,
	type DaemonUpdateRestartStatus,
} from "../src/cli/daemon-update-restart.js";
import {
	ENV_AGENT_DIR,
	getDaemonUpdateRestartManifestPath,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	VERSION,
} from "../src/config.js";
import type { AgentSessionRuntimeMetadata } from "../src/core/agent-session-runtime.js";
import type * as DaemonSocketModule from "../src/modes/daemon/daemon-socket.js";
import { handlePackageCommand, runDaemonUpdateRestartCoordinator } from "../src/package-manager-cli.js";

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

interface MockCustomMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
}

interface MockQueuedMessage {
	message: string;
	content?: Array<{ type: "text"; text: string }>;
	agentMessageId?: string;
	queueKey?: string;
	customMessage?: MockCustomMessage;
	prefixMessages?: MockCustomMessage[];
}

interface MockUpdateRestartSession {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	config: Record<string, unknown>;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
	queue: {
		steering: MockQueuedMessage[];
		followUp: MockQueuedMessage[];
		nextTurn: MockCustomMessage[];
		acceptedPrompt?: MockQueuedMessage & { nextTurn: MockCustomMessage[] };
	};
	shouldResume: boolean;
	wasStreaming: boolean;
	wasCompacting: boolean;
	wasBashRunning: boolean;
	hadRunningRlmChildren: boolean;
	wasRetrying: boolean;
	hadAcceptedPromptInFlight: boolean;
}

interface MockUpdateRestartManifest {
	createdAt: string;
	sessions: MockUpdateRestartSession[];
}

interface MockDaemonRequest {
	type: string;
	activeSessionId?: string;
	message?: string;
	agentMessageId?: string;
	customMessage?: MockCustomMessage;
	prefixMessages?: MockCustomMessage[];
	content?: unknown;
	messages?: MockCustomMessage[];
	queueKey?: string;
	sessionPath?: string;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
}

type MockDaemonResponse = { success: true; data?: unknown } | { success: false; error: string };

const mockState = vi.hoisted(() => ({
	calls: [] as string[],
	createActiveSessionIds: [] as string[],
	createThrowSessionPaths: [] as string[],
	daemonProbe: { reachable: true, activeSessions: [] } as MockRunningDaemonProbe,
	globalPackageRoot: "",
	hello: { protocol: { version: 2 } } as {
		protocol: { version: number };
		supervisorGeneration?: string;
		supervisorOwnerToken?: string;
		supervisorPid?: number;
		supervisorProcessStartId?: string;
		supervisorSocketPath?: string;
	},
	helloCount: 0,
	lastCoordinatorStatus: undefined as DaemonUpdateRestartStatus | undefined,
	prepareError: undefined as string | undefined,
	prepareManifest: { createdAt: "2026-07-07T00:00:00.000Z", sessions: [] } as MockUpdateRestartManifest,
	preparedManifestPath: "",
	promptFailures: 0,
	probeSocketPaths: [] as string[],
	requestPayloads: [] as MockDaemonRequest[],
	restoreNextTurnFailures: 0,
	socketPath: "",
	successorProcessStartId: "replacement-start" as string | undefined,
	successorSocketPath: undefined as string | undefined,
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

vi.mock("../src/cli/daemon-update-restart.js", async (importOriginal) => {
	const original = await importOriginal<typeof DaemonUpdateRestartModule>();
	return {
		...original,
		launchDaemonUpdateRestartCoordinator: vi.fn(async (options: { socketPath: string }) => {
			mockState.calls.push(`launch-coordinator:${options.socketPath}`);
			return {
				version: 1,
				requestId: "test-request",
				socketPath: options.socketPath,
				phase: "complete",
				coordinator: { pid: process.pid },
				counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
		}),
	};
});

vi.mock("../src/modes/daemon/daemon-socket.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonSocketModule>()),
	defaultDaemonSocketPath: () => mockState.socketPath,
}));

vi.mock("../src/modes/daemon/daemon-supervisor-ownership.js", () => ({
	persistDaemonStartupFenceFromOwner: vi.fn(async () => {
		mockState.calls.push("persist-daemon-startup-fence");
	}),
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
	probeRunningDaemonSessions: vi.fn(async (socketPath: string) => {
		mockState.calls.push("probe-daemon");
		mockState.probeSocketPaths.push(socketPath);
		return mockState.daemonProbe;
	}),
	shutdownConnectedDaemonAndWait: vi.fn(async () => {
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

		get isConnected(): boolean {
			return true;
		}

		async waitForHello(): Promise<{
			protocol: { version: number };
			appVersion: string;
			supervisorGeneration?: string;
			supervisorOwnerToken?: string;
			supervisorPid?: number;
			supervisorProcessStartId?: string;
			supervisorSocketPath?: string;
		}> {
			const helloCount = mockState.helloCount++;
			return helloCount === 0
				? {
						appVersion: VERSION,
						...mockState.hello,
					}
				: {
						protocol: { version: 2 },
						appVersion: VERSION,
						supervisorPid: 1002,
						supervisorGeneration: "replacement-generation",
						supervisorOwnerToken: "replacement-owner-token",
						...(mockState.successorProcessStartId
							? { supervisorProcessStartId: mockState.successorProcessStartId }
							: {}),
						supervisorSocketPath: mockState.successorSocketPath ?? mockState.socketPath,
					};
		}

		async requestLegacy(request: MockDaemonRequest): Promise<MockDaemonResponse> {
			return this.request(request);
		}

		async request(request: MockDaemonRequest): Promise<MockDaemonResponse> {
			mockState.calls.push(`daemon-request:${request.type}`);
			mockState.requestPayloads.push(request);
			if (request.type === "prepare_update_restart") {
				if (mockState.prepareError) {
					return { success: false, error: mockState.prepareError };
				}
				writeFileSync(mockState.preparedManifestPath, `${JSON.stringify(mockState.prepareManifest)}\n`);
				return { success: true, data: mockState.prepareManifest };
			}
			if (request.type === "create") {
				if (request.sessionPath && mockState.createThrowSessionPaths.includes(request.sessionPath)) {
					throw new Error("create failed");
				}
				const activeSessionId = mockState.createActiveSessionIds.shift() ?? "restored-active";
				return { success: true, data: { id: activeSessionId, activeSessionId } };
			}
			if (request.type === "restore_next_turn" && mockState.restoreNextTurnFailures > 0) {
				mockState.restoreNextTurnFailures--;
				return { success: false, error: "restore failed" };
			}
			if (request.type === "prompt" && mockState.promptFailures > 0) {
				mockState.promptFailures--;
				return { success: false, error: "prompt failed" };
			}
			return { success: true };
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

	async function performUpdateAndRunCoordinator(originActiveSessionId?: string): Promise<void> {
		await handlePackageCommand(["update", "--self", "--daemon-socket", mockState.socketPath]);
		const restartDirectory = join(agentDir, "update-restarts");
		mkdirSync(restartDirectory, { recursive: true });
		mockState.lastCoordinatorStatus = await runDaemonUpdateRestartCoordinator({
			socketPath: mockState.socketPath,
			agentDir,
			statusPath: join(restartDirectory, "test-status.json"),
			originActiveSessionId,
		});
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-self-update-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "global-prefix", "lib", "node_modules", PACKAGE_NAME);
		mockState.globalPackageRoot = join(tempDir, "global-prefix", "lib", "node_modules");
		mockState.hello = { protocol: { version: 2 } };
		mockState.helloCount = 0;
		mockState.lastCoordinatorStatus = undefined;
		mockState.prepareError = undefined;
		mockState.socketPath = join(tempDir, "daemon.sock");
		mockState.successorProcessStartId = "replacement-start";
		mockState.successorSocketPath = undefined;
		mockState.calls = [];
		mockState.createActiveSessionIds = [];
		mockState.createThrowSessionPaths = [];
		mockState.daemonProbe = { reachable: true, activeSessions: [] };
		mockState.prepareManifest = { createdAt: "2026-07-07T00:00:00.000Z", sessions: [] };
		mockState.preparedManifestPath = getDaemonUpdateRestartManifestPath(agentDir);
		mockState.promptFailures = 0;
		mockState.probeSocketPaths = [];
		mockState.requestPayloads = [];
		mockState.restoreNextTurnFailures = 0;
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
		delete process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses the interactive no-change sentinel only when self-update is unchanged", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "0.2.6" })),
		);

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
		expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
	});

	it("does not use the no-change sentinel when interactive self-update is cancelled", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		mockState.daemonProbe = {
			reachable: true,
			activeSessions: [
				{
					id: "busy",
					activeSessionId: "busy",
					isStreaming: true,
					isCompacting: false,
					pendingMessageCount: 0,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
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

	it("defers the exact custom-socket restart to the interactive parent", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		const customSocketPath = join(tempDir, "custom", "daemon.sock");

		await expect(handlePackageCommand(["update", "--self", "--daemon-socket", customSocketPath])).resolves.toBe(true);

		expect(mockState.probeSocketPaths).toEqual([customSocketPath]);
		expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(true);
		expect(mockState.calls.some((call) => call.startsWith("launch-coordinator:"))).toBe(false);
	});

	it("serializes coordinators per exact socket", async () => {
		const registryDir = join(tempDir, "restart-registry");
		const first = await acquireDaemonUpdateRestartCoordinator({
			requestId: "first",
			socketPath: mockState.socketPath,
			statusPath: join(agentDir, "first.json"),
			registryDir,
		});
		try {
			await expect(
				acquireDaemonUpdateRestartCoordinator({
					requestId: "second",
					socketPath: mockState.socketPath,
					statusPath: join(agentDir, "second.json"),
					registryDir,
				}),
			).rejects.toThrow("already running");
		} finally {
			await first.release();
		}
	});

	it("rejects a successor that answers for another socket", async () => {
		mockState.successorSocketPath = join(tempDir, "wrong-daemon.sock");

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "failed",
			message: expect.stringContaining("does not match"),
		});
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
	});

	it("accepts a fixed replacement owner when process start ids are unavailable", async () => {
		mockState.hello = {
			protocol: { version: 2 },
			supervisorGeneration: "predecessor-generation",
			supervisorOwnerToken: "predecessor-owner-token",
			supervisorPid: 1001,
			supervisorSocketPath: mockState.socketPath,
		};
		mockState.successorProcessStartId = undefined;

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			successor: {
				pid: 1002,
				supervisorGeneration: "replacement-generation",
				supervisorOwnerToken: "replacement-owner-token",
			},
		});
	});

	it("clears the prepared manifest after fallback restoration when shutdown fails", async () => {
		mockState.shutdownResult = false;
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: {},
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "failed",
			counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
		});
		expect(existsSync(mockState.preparedManifestPath)).toBe(false);
	});

	it("restarts an idle legacy daemon without a restorable manifest", async () => {
		mockState.hello = { protocol: { version: 1 } };
		mockState.prepareError = "Unknown daemon command: prepare_update_restart";

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
		});
		expect(mockState.calls).toContain("shutdown-daemon");
		expect(mockState.calls).toContain("ensure-daemon");
	});

	it("restarts the daemon only after the package update succeeds", async () => {
		mockState.hello = {
			protocol: { version: 2 },
			supervisorGeneration: "fixed-owner",
			supervisorOwnerToken: "owner-token",
			supervisorPid: process.pid,
			supervisorProcessStartId: "process-start",
			supervisorSocketPath: mockState.socketPath,
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			const spawnIndex = mockState.calls.findIndex((call) => call.startsWith("spawn:npm "));
			const launchIndex = mockState.calls.indexOf(`launch-coordinator:${mockState.socketPath}`);
			const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
			const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
			const shutdownIndex = mockState.calls.indexOf("shutdown-daemon");
			const ensureIndex = mockState.calls.indexOf("ensure-daemon");
			expect(spawnIndex).toBeGreaterThanOrEqual(0);
			expect(launchIndex).toBeGreaterThan(spawnIndex);
			expect(fenceIndex).toBeGreaterThan(launchIndex);
			expect(prepareIndex).toBeGreaterThan(fenceIndex);
			expect(shutdownIndex).toBeGreaterThan(prepareIndex);
			expect(ensureIndex).toBeGreaterThan(shutdownIndex);
			expect(statSync(join(agentDir, "update-restarts", "test-status.json")).mode & 0o777).toBe(0o600);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("skips predecessor fencing when the daemon hello has no fixed-owner identity", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("still resumes accepted prompts when accepted context restore fails", async () => {
		mockState.restoreNextTurnFailures = 1;
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						steering: [],
						followUp: [],
						nextTurn: [
							{
								role: "custom",
								customType: "prime-agent.test",
								content: "subsequent turn context",
								display: false,
								timestamp: Date.now(),
							},
						],
						acceptedPrompt: {
							message: "accepted work",
							content: [{ type: "text", text: "accepted work" }],
							agentMessageId: "agentmsg_accepted",
							nextTurn: [
								{
									role: "custom",
									customType: "prime-agent.test",
									content: "accepted prompt context",
									display: false,
									timestamp: Date.now(),
								},
							],
						},
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator("old-active")).resolves.toBeUndefined();

			const promptRequests = mockState.requestPayloads.filter((request) => request.type === "prompt");
			expect(promptRequests).toEqual([
				expect.objectContaining({
					activeSessionId: "restored-active",
					message: "accepted work",
					agentMessageId: "agentmsg_accepted",
				}),
			]);
			const noticeIndex = mockState.requestPayloads.findIndex(
				(request) => request.type === "append_custom_message" && request.activeSessionId === "restored-active",
			);
			const promptIndex = mockState.requestPayloads.findIndex((request) => request.type === "prompt");
			expect(noticeIndex).toBeGreaterThanOrEqual(0);
			expect(promptIndex).toBeGreaterThan(noticeIndex);
			const subsequentNextTurnIndex = mockState.requestPayloads.findIndex(
				(request) =>
					request.type === "restore_next_turn" &&
					request.messages?.some((message) => message.content === "subsequent turn context") === true,
			);
			expect(promptIndex).toBeGreaterThanOrEqual(0);
			expect(subsequentNextTurnIndex).toBeGreaterThan(promptIndex);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("continues restoring later sessions when one session restore throws", async () => {
		const failedSessionFile = join(projectDir, "failed.jsonl");
		const restoredSessionFile = join(projectDir, "restored.jsonl");
		mockState.createThrowSessionPaths = [failedSessionFile];
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "failed-active",
					sessionId: "failed-session",
					sessionFile: failedSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "restored-active",
					sessionId: "restored-session",
					sessionFile: restoredSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(
				mockState.requestPayloads
					.filter((request) => request.type === "create")
					.map((request) => request.sessionPath),
			).toEqual([failedSessionFile, restoredSessionFile]);
			expect(
				mockState.requestPayloads.some(
					(request) => request.type === "prompt" && request.activeSessionId === "restored-active",
				),
			).toBe(true);
			expect(mockState.lastCoordinatorStatus?.counts).toEqual({
				total: 2,
				restored: 1,
				resumed: 1,
				failed: 1,
			});
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("restores subagent runtime metadata under the recreated parent session", async () => {
		const parentSessionFile = join(projectDir, "parent.jsonl");
		const childSessionFile = join(projectDir, "child.jsonl");
		mockState.createActiveSessionIds = ["new-parent", "new-child"];
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-parent",
					sessionId: "parent-session",
					sessionFile: parentSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: { kind: "top-level", createdAt: 1 },
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "old-child",
					sessionId: "child-session",
					sessionFile: childSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: {
						kind: "subagent",
						createdAt: 2,
						parentActiveSessionId: "old-parent",
						parentSessionId: "parent-session",
						parentSessionFile,
						rlmChildId: "child-1",
						prompt: "child task",
					},
					queue: { steering: [], followUp: [], nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			const createRequests = mockState.requestPayloads.filter((request) => request.type === "create");
			expect(createRequests).toHaveLength(2);
			expect(createRequests[0]).toMatchObject({
				sessionPath: parentSessionFile,
				runtimeMetadata: { kind: "top-level", createdAt: 1 },
			});
			expect(createRequests[1]).toMatchObject({
				sessionPath: childSessionFile,
				runtimeMetadata: {
					kind: "subagent",
					createdAt: 2,
					parentActiveSessionId: "new-parent",
					parentSessionId: "parent-session",
					parentSessionFile,
					rlmChildId: "child-1",
					prompt: "child task",
				},
			});
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("preserves queued custom messages and prefixes when restoring update restart queues", async () => {
		const customMessage: MockCustomMessage = {
			role: "custom",
			customType: "heartbeat_prompt",
			content: "heartbeat body",
			display: true,
			timestamp: Date.now(),
		};
		const prefixMessage: MockCustomMessage = {
			role: "custom",
			customType: "ipython_state_restored",
			content: "restore context",
			display: true,
			timestamp: Date.now(),
		};
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						steering: [],
						followUp: [
							{
								message: "heartbeat body",
								queueKey: "heartbeat:job-1",
								agentMessageId: "agentmsg_followup",
								customMessage,
								prefixMessages: [prefixMessage],
							},
						],
						nextTurn: [],
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(mockState.requestPayloads).toContainEqual(
				expect.objectContaining({
					type: "follow_up",
					activeSessionId: "restored-active",
					message: "heartbeat body",
					queueKey: "heartbeat:job-1",
					agentMessageId: "agentmsg_followup",
					customMessage,
					prefixMessages: [prefixMessage],
				}),
			);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not resume queued work when accepted prompt replay fails", async () => {
		mockState.promptFailures = 1;
		mockState.prepareManifest = {
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						steering: [],
						followUp: [{ message: "queued follow-up", agentMessageId: "agentmsg_followup" }],
						nextTurn: [],
						acceptedPrompt: {
							message: "accepted work",
							agentMessageId: "agentmsg_accepted",
							nextTurn: [],
						},
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(mockState.requestPayloads.some((request) => request.type === "follow_up")).toBe(true);
			expect(mockState.requestPayloads.some((request) => request.type === "resume_queue")).toBe(false);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
