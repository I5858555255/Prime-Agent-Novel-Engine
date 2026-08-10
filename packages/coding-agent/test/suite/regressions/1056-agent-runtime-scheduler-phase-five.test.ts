import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConflictResolverContext } from "../../../src/core/agent-conflict-resolver.js";
import type { AgentGitWorkspace } from "../../../src/core/agent-git-worktree.js";
import {
	type AgentRuntimeIntegrationRecord,
	AgentRuntimeScheduler,
} from "../../../src/core/agent-runtime-scheduler.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const cleanupRoots: string[] = [];
const cleanupHarnesses: Harness[] = [];
const BASE_CONTENT = "component=empty\n";

afterEach(() => {
	for (const harness of cleanupHarnesses.splice(0).reverse()) harness.cleanup();
	for (const root of cleanupRoots.splice(0).reverse()) {
		rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
	}
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(prefix: string): { root: string; repository: string } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	cleanupRoots.push(root);
	const repository = join(root, "repository");
	mkdirSync(repository);
	git(repository, ["init"]);
	git(repository, ["branch", "-M", "main"]);
	git(repository, ["config", "user.email", "test@example.com"]);
	git(repository, ["config", "user.name", "Test User"]);
	git(repository, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(repository, "shared.txt"), BASE_CONTENT);
	git(repository, ["add", "shared.txt"]);
	git(repository, ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"]);
	return { root, repository };
}

async function createCandidate(
	scheduler: AgentRuntimeScheduler,
	repository: string,
	root: string,
	id: string,
	writeChanges: (workspacePath: string) => void,
): Promise<AgentGitWorkspace> {
	scheduler.registerTask({ id, objective: `Complete ${id}`, status: "queued" });
	scheduler.registerAgent({ id, taskId: id });
	scheduler.transitionTask(id, "preparing_workspace");
	const workspace = await scheduler.prepareAgentWorkspace(id, {
		sourceCwd: repository,
		metadataDir: join(root, "metadata", id),
	});
	if (!workspace) throw new Error("Expected Git worktree provisioning");
	scheduler.markAgentRunning(id);
	scheduler.transitionTask(id, "running");
	writeChanges(workspace.worktreePath);
	await scheduler.finalizeAgentWorkspace(id, `${id} finished`);
	scheduler.completeAgent(id);
	scheduler.transitionTask(id, "completed");
	return workspace;
}

function requireIntegration(record: AgentRuntimeIntegrationRecord | undefined): AgentRuntimeIntegrationRecord {
	if (!record) throw new Error("Expected integration record");
	return record;
}

describe("issue 1056 agent runtime scheduler phase five", () => {
	it("resolves a Git conflict in an isolated resolver worktree with both task contracts", async () => {
		const { root, repository } = createRepository("prime-agent-resolution-1056-");
		const resolverContexts: AgentConflictResolverContext[] = [];
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-resolution",
			statePath: join(root, "scheduler", "state.json"),
			integrationQualityGates: [
				{
					id: "shared-content",
					command: process.execPath,
					args: [
						"-e",
						"const fs=require('node:fs');const value=fs.readFileSync('shared.txt','utf8');if(value!=='first\\n'&&value!=='first\\nsecond\\n')process.exit(9)",
					],
				},
			],
			conflictResolver: async (context) => {
				resolverContexts.push(context);
				writeFileSync(join(context.workspace.worktreePath, "shared.txt"), "first\nsecond\n");
				return { summary: "Preserved both component registrations.", sessionId: "resolver-session" };
			},
		});
		const firstWorkspace = await createCandidate(scheduler, repository, root, "task-first", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "first\n");
		});
		const secondWorkspace = await createCandidate(scheduler, repository, root, "task-second", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "second\n");
		});
		await scheduler.integrateAgentWorkspace("task-first");
		const record = requireIntegration(await scheduler.integrateAgentWorkspace("task-second"));

		expect(record).toMatchObject({ status: "integrated", conflictFiles: ["shared.txt"] });
		expect(resolverContexts).toHaveLength(1);
		expect(resolverContexts[0]).toMatchObject({
			trigger: "git_conflict",
			conflictFiles: ["shared.txt"],
			taskContracts: [
				expect.objectContaining({ taskId: "task-second" }),
				expect.objectContaining({ taskId: "task-first" }),
			],
		});
		expect(resolverContexts[0].candidatePatch).toContain("second");
		expect(resolverContexts[0].workspace.worktreePath).not.toBe(firstWorkspace.worktreePath);
		expect(resolverContexts[0].workspace.worktreePath).not.toBe(secondWorkspace.worktreePath);
		expect(scheduler.summary().conflictResolutions).toEqual([
			expect.objectContaining({
				status: "resolved",
				resolverSessionId: "resolver-session",
				workspaceCleanedAt: expect.any(String),
				validationGateResults: [expect.objectContaining({ id: "shared-content", passed: true })],
			}),
		]);
		const integrationWorkspace = scheduler.summary().integrationWorkspaces[0];
		expect(readFileSync(join(integrationWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("first\nsecond\n");
		expect(readFileSync(join(firstWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(secondWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("second\n");
		expect(scheduler.getTask("task-second")?.status).toBe("integrated");
		expect(git(repository, ["branch", "--show-current"])).toBe("main");
		expect(readFileSync(join(repository, "shared.txt"), "utf8")).toBe(BASE_CONTENT);
	});

	it("repairs a rolled-back quality-gate failure and reruns the affected gate", async () => {
		const { root, repository } = createRepository("prime-agent-gate-resolution-1056-");
		let observedContext: AgentConflictResolverContext | undefined;
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-gate-resolution",
			statePath: join(root, "scheduler", "state.json"),
			integrationQualityGates: [
				{
					id: "approval",
					command: process.execPath,
					args: [
						"-e",
						"const fs=require('node:fs');if(!fs.readFileSync('shared.txt','utf8').includes('approved'))process.exit(7)",
					],
				},
			],
			conflictResolver: async (context) => {
				observedContext = context;
				writeFileSync(join(context.workspace.worktreePath, "shared.txt"), "component=approved\n");
				return { summary: "Added the required approval state." };
			},
		});
		const candidateWorkspace = await createCandidate(scheduler, repository, root, "task-gated", (workspacePath) => {
			writeFileSync(join(workspacePath, "feature.txt"), "feature\n");
		});
		const record = requireIntegration(await scheduler.integrateAgentWorkspace("task-gated"));

		expect(record.status).toBe("integrated");
		expect(observedContext).toMatchObject({
			trigger: "quality_gate_failure",
			attemptedSha: expect.any(String),
			inputGateResults: [expect.objectContaining({ id: "approval", passed: false, exitCode: 7 })],
		});
		const resolution = scheduler.summary().conflictResolutions[0];
		expect(resolution).toMatchObject({
			status: "resolved",
			trigger: "quality_gate_failure",
			validationGateResults: [expect.objectContaining({ id: "approval", passed: true })],
		});
		const integrationWorkspace = scheduler.summary().integrationWorkspaces[0];
		expect(readFileSync(join(integrationWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("component=approved\n");
		expect(readFileSync(join(integrationWorkspace.worktreePath, "feature.txt"), "utf8")).toBe("feature\n");
		expect(readFileSync(join(candidateWorkspace.worktreePath, "shared.txt"), "utf8")).toBe(BASE_CONTENT);
	});

	it("bounds failed retries, preserves every attempt, and requests user direction", async () => {
		const { root, repository } = createRepository("prime-agent-escalation-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-escalation",
			statePath: join(root, "scheduler", "state.json"),
			conflictResolutionMaxAttempts: 2,
			conflictResolver: async () => ({ summary: "Unable to determine the intended value." }),
		});
		await createCandidate(scheduler, repository, root, "task-first", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "first\n");
		});
		const secondWorkspace = await createCandidate(scheduler, repository, root, "task-second", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "second\n");
		});
		await scheduler.integrateAgentWorkspace("task-first");
		const record = requireIntegration(await scheduler.integrateAgentWorkspace("task-second"));
		const resolutions = scheduler.summary().conflictResolutions;

		expect(record).toMatchObject({ status: "conflict", conflictFiles: ["shared.txt"] });
		expect(resolutions).toHaveLength(2);
		expect(resolutions[0]).toMatchObject({ status: "failed", attempt: 1, maxAttempts: 2 });
		expect(resolutions[1]).toMatchObject({ status: "escalated", attempt: 2, maxAttempts: 2 });
		for (const resolution of resolutions) {
			expect(resolution.worktreePath && existsSync(resolution.worktreePath)).toBe(true);
			expect(resolution.contextPath && existsSync(resolution.contextPath)).toBe(true);
			expect(resolution.error).toContain("leftover conflict marker");
		}
		expect(scheduler.snapshot().events.map((event) => event.type)).toContain("resolution_escalated");
		expect(scheduler.snapshot().events.at(-1)?.message).toContain("user direction is required");
		expect(scheduler.getTask("task-second")?.status).toBe("conflict");
		expect(readFileSync(join(secondWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("second\n");
	});

	it("times out a stalled resolver without inspecting or promoting its live workspace", async () => {
		const { root, repository } = createRepository("prime-agent-timeout-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-timeout",
			statePath: join(root, "scheduler", "state.json"),
			conflictResolutionMaxAttempts: 1,
			conflictResolutionTimeoutMs: 20,
			conflictResolver: async () => await new Promise(() => undefined),
		});
		await createCandidate(scheduler, repository, root, "task-first", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "first\n");
		});
		await createCandidate(scheduler, repository, root, "task-second", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "second\n");
		});
		await scheduler.integrateAgentWorkspace("task-first");
		const integrationWorkspace = scheduler.summary().integrationWorkspaces[0];
		const recoverySha = git(integrationWorkspace.worktreePath, ["rev-parse", "HEAD"]);
		const record = requireIntegration(await scheduler.integrateAgentWorkspace("task-second"));
		const [resolution] = scheduler.summary().conflictResolutions;

		expect(record.status).toBe("conflict");
		expect(resolution).toMatchObject({
			status: "escalated",
			attempt: 1,
			error: "Conflict resolver timed out after 20ms",
		});
		expect(resolution.worktreePath && existsSync(resolution.worktreePath)).toBe(true);
		expect(git(integrationWorkspace.worktreePath, ["rev-parse", "HEAD"])).toBe(recoverySha);
		expect(readFileSync(join(integrationWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("first\n");
	});

	it("runs the resolver through the root AgentSession in the isolated resolver cwd", async () => {
		const { root, repository } = createRepository("prime-agent-session-resolution-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-session-resolution",
			statePath: join(root, "scheduler", "state.json"),
			conflictResolutionMaxAttempts: 1,
		});
		const resolverChild = await createHarness();
		cleanupHarnesses.push(resolverChild);
		resolverChild.setResponses([fauxAssistantMessage("Resolved both task intents.")]);
		let runtimeOptions: CreateRlmSubagentRuntimeOptions | undefined;
		let releaseStatus: string | undefined;
		const parent = await createHarness({
			agentRuntimeScheduler: scheduler,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async (options) => {
					runtimeOptions = options;
					if (!options.cwd) throw new Error("Expected resolver cwd");
					writeFileSync(join(options.cwd, "shared.txt"), "first\nsecond\n");
					return { session: resolverChild.session };
				},
				releaseRlmSubagentRuntime: async (_runtime, _options, status) => {
					releaseStatus = status;
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		cleanupHarnesses.push(parent);
		await createCandidate(scheduler, repository, root, "task-first", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "first\n");
		});
		const candidateWorkspace = await createCandidate(scheduler, repository, root, "task-second", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "second\n");
		});
		await scheduler.integrateAgentWorkspace("task-first");
		const record = requireIntegration(await scheduler.integrateAgentWorkspace("task-second"));

		expect(record.status).toBe("integrated");
		expect(runtimeOptions?.cwd).toContain(`${join("resolutions", candidateWorkspace.repositoryId)}`);
		expect(runtimeOptions?.cwd).not.toBe(candidateWorkspace.worktreePath);
		expect(runtimeOptions?.prompt).toContain("Task contracts:");
		expect(resolverChild.session.messages.map(getMessageText).join("\n")).toContain(
			"Do not modify either worker branch or the integration worktree.",
		);
		expect(releaseStatus).toBe("done");
		expect(scheduler.summary().conflictResolutions[0]).toMatchObject({
			status: "resolved",
			resolverSessionId: resolverChild.session.sessionId,
			summary: "Resolved both task intents.",
		});
	});

	it("migrates phase-four scheduler state with an empty resolution registry", () => {
		const { root, repository } = createRepository("prime-agent-resolution-migration-1056-");
		const statePath = join(root, "scheduler", "state.json");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-resolution-migration",
			statePath,
		});
		const phaseFourState = scheduler.snapshot();
		const serialized = JSON.parse(JSON.stringify(phaseFourState)) as Record<string, unknown>;
		serialized.version = 4;
		delete serialized.conflictResolutions;
		writeFileSync(statePath, `${JSON.stringify(serialized, null, 2)}\n`);

		const restored = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-resolution-migration",
			statePath,
		});
		expect(restored.snapshot()).toMatchObject({ version: 6, conflictResolutions: [], integrationQualityGates: [] });
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
			version: 6,
			conflictResolutions: [],
		});
	});
});
