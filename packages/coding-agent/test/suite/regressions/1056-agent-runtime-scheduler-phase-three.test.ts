import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGitWorkspace } from "../../../src/core/agent-git-worktree.js";
import {
	type AgentRuntimeIntegrationRecord,
	AgentRuntimeScheduler,
} from "../../../src/core/agent-runtime-scheduler.js";

const cleanupRoots: string[] = [];
const BASE_DECLARATIONS = "component-a=empty\ncontext-1\ncontext-2\ncontext-3\ncomponent-b=empty\n";

afterEach(() => {
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
	writeFileSync(join(repository, "shared.txt"), BASE_DECLARATIONS);
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

describe("issue 1056 agent runtime scheduler phase three", () => {
	it("serializes compatible candidates into a scheduler-owned integration branch", async () => {
		const { root, repository } = createRepository("prime-agent-merge-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-compatible",
			statePath: join(root, "scheduler", "state.json"),
		});
		await createCandidate(scheduler, repository, root, "task-a", (workspacePath) => {
			const declarations = readFileSync(join(workspacePath, "shared.txt"), "utf8");
			writeFileSync(
				join(workspacePath, "shared.txt"),
				declarations.replace("component-a=empty", "component-a=agent-a"),
			);
		});
		await createCandidate(scheduler, repository, root, "task-b", (workspacePath) => {
			const declarations = readFileSync(join(workspacePath, "shared.txt"), "utf8");
			writeFileSync(
				join(workspacePath, "shared.txt"),
				declarations.replace("component-b=empty", "component-b=agent-b"),
			);
		});
		scheduler.registerTask({
			id: "task-downstream",
			objective: "Run after task-a integrates",
			dependencies: ["task-a"],
			status: "queued",
		});
		expect(scheduler.getTaskReadiness("task-downstream")).toEqual({
			taskId: "task-downstream",
			ready: false,
			blockedBy: ["task-a"],
		});

		const [first, second] = await Promise.all([
			scheduler.integrateAgentWorkspace("task-a"),
			scheduler.integrateAgentWorkspace("task-b"),
		]);
		expect(first).toMatchObject({ status: "integrated", changedFiles: ["shared.txt"] });
		expect(second).toMatchObject({ status: "integrated", changedFiles: ["shared.txt"] });
		const integrationWorkspace = scheduler.summary().integrationWorkspaces[0];
		expect(integrationWorkspace.branch).toContain("prime-agent/run-compatible/integration");
		expect(readFileSync(join(integrationWorkspace.worktreePath, "shared.txt"), "utf8")).toBe(
			"component-a=agent-a\ncontext-1\ncontext-2\ncontext-3\ncomponent-b=agent-b\n",
		);
		expect(scheduler.getTask("task-a")?.status).toBe("integrated");
		expect(scheduler.getTask("task-b")?.status).toBe("integrated");
		expect(scheduler.getTaskReadiness("task-downstream")).toEqual({
			taskId: "task-downstream",
			ready: true,
			blockedBy: [],
		});
		expect(scheduler.summary().integrationRecords.map((record) => record.taskId)).toEqual(["task-a", "task-b"]);
		expect(readFileSync(join(repository, "shared.txt"), "utf8")).toBe(BASE_DECLARATIONS);
		expect(git(repository, ["branch", "--show-current"])).toBe("main");
	});

	it("reports merge conflicts without changing the previous integration result or either candidate", async () => {
		const { root, repository } = createRepository("prime-agent-conflict-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-conflict",
			statePath: join(root, "scheduler", "state.json"),
		});
		const firstWorkspace = await createCandidate(scheduler, repository, root, "task-first", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "first\n");
		});
		const secondWorkspace = await createCandidate(scheduler, repository, root, "task-second", (workspacePath) => {
			writeFileSync(join(workspacePath, "shared.txt"), "second\n");
		});
		const first = requireIntegration(await scheduler.integrateAgentWorkspace("task-first"));
		const second = requireIntegration(await scheduler.integrateAgentWorkspace("task-second"));

		expect(first.status).toBe("integrated");
		expect(second).toMatchObject({ status: "conflict", conflictFiles: ["shared.txt"] });
		const integrationWorkspace = scheduler.summary().integrationWorkspaces[0];
		expect(readFileSync(join(integrationWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(firstWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("first\n");
		expect(readFileSync(join(secondWorkspace.worktreePath, "shared.txt"), "utf8")).toBe("second\n");
		expect(git(integrationWorkspace.worktreePath, ["status", "--porcelain=v1"])).toBe("");
		expect(scheduler.getTask("task-second")?.status).toBe("conflict");
	});

	it("rolls the integration branch back when a quality gate fails", async () => {
		const { root, repository } = createRepository("prime-agent-gate-1056-");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-gate",
			statePath: join(root, "scheduler", "state.json"),
			integrationQualityGates: [{ id: "reject", command: process.execPath, args: ["-e", "process.exit(7)"] }],
		});
		const candidateWorkspace = await createCandidate(scheduler, repository, root, "task-gated", (workspacePath) => {
			writeFileSync(join(workspacePath, "gated.txt"), "candidate survives\n");
		});
		const record = requireIntegration(await scheduler.integrateAgentWorkspace("task-gated"));
		const integrationWorkspace = scheduler.summary().integrationWorkspaces[0];

		expect(record).toMatchObject({
			status: "failed",
			recoverySha: expect.any(String),
			attemptedSha: expect.any(String),
			changedFiles: ["gated.txt"],
			error: "Integration quality gate failed: reject",
			gateResults: [expect.objectContaining({ id: "reject", passed: false, exitCode: 7 })],
		});
		expect(git(integrationWorkspace.worktreePath, ["rev-parse", "HEAD"])).toBe(record.recoverySha);
		expect(git(integrationWorkspace.worktreePath, ["status", "--porcelain=v1"])).toBe("");
		expect(git(repository, ["cat-file", "-t", record.attemptedSha!])).toBe("commit");
		expect(readFileSync(join(candidateWorkspace.worktreePath, "gated.txt"), "utf8")).toBe("candidate survives\n");
		expect(scheduler.getTask("task-gated")?.status).toBe("failed");
	});

	it("restores the recovery point and resumes an interrupted integration after restart", async () => {
		const { root, repository } = createRepository("prime-agent-resume-1056-");
		const statePath = join(root, "scheduler", "state.json");
		const scheduler = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-resume",
			statePath,
		});
		await createCandidate(scheduler, repository, root, "task-base", (workspacePath) => {
			writeFileSync(join(workspacePath, "base-result.txt"), "integrated first\n");
		});
		await scheduler.integrateAgentWorkspace("task-base");
		await createCandidate(scheduler, repository, root, "task-resume", (workspacePath) => {
			writeFileSync(join(workspacePath, "resumed.txt"), "resumed candidate\n");
		});
		scheduler.transitionTask("task-resume", "integrating");
		const agent = scheduler.getAgent("task-resume");
		const integrationWorkspace = scheduler.summary().integrationWorkspaces[0];
		if (!agent?.repositoryId || !agent.baseSha || !agent.candidateSha) {
			throw new Error("Expected persisted candidate identity");
		}
		const snapshot = scheduler.snapshot();
		snapshot.integrationRecords.push({
			taskId: "task-resume",
			agentId: "task-resume",
			repositoryId: agent.repositoryId,
			baseSha: agent.baseSha,
			candidateSha: agent.candidateSha,
			status: "integrating",
			queuedAt: new Date().toISOString(),
			startedAt: new Date().toISOString(),
			recoverySha: integrationWorkspace.headSha,
			changedFiles: [],
			conflictFiles: [],
			gateResults: [],
		});
		writeFileSync(statePath, `${JSON.stringify(snapshot, null, 2)}\n`);
		git(integrationWorkspace.worktreePath, ["merge", "--no-ff", "--no-commit", agent.candidateSha]);
		expect(git(integrationWorkspace.worktreePath, ["status", "--porcelain=v1"])).not.toBe("");

		const restored = new AgentRuntimeScheduler({
			workspacePath: repository,
			runId: "run-resume",
			statePath,
		});
		expect(restored.getIntegrationRecord("task-resume")?.status).toBe("queued");
		const [record] = await restored.resumePendingIntegrations();
		expect(record).toMatchObject({ status: "integrated", changedFiles: ["resumed.txt"] });
		expect(readFileSync(join(integrationWorkspace.worktreePath, "resumed.txt"), "utf8")).toBe("resumed candidate\n");
		expect(git(integrationWorkspace.worktreePath, ["status", "--porcelain=v1"])).toBe("");
		expect(restored.getTask("task-resume")?.status).toBe("integrated");
	});
});
