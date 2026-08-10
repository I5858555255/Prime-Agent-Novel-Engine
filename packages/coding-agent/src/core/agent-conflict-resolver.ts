import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentGitWorkspace, AgentRuntimeTaskContract } from "./agent-git-worktree.js";
import type { AgentIntegrationGateResult } from "./agent-merge-manager.js";

export type AgentConflictResolutionTrigger = "git_conflict" | "quality_gate_failure";

export type AgentConflictResolutionStatus = "queued" | "running" | "resolved" | "failed" | "timed_out" | "escalated";

export interface AgentConflictResolutionWorkspace {
	repositoryId: string;
	repositoryRoot: string;
	branch: string;
	worktreePath: string;
	contextPath: string;
}

export interface AgentConflictResolutionRecord {
	id: string;
	taskId: string;
	agentId: string;
	repositoryId: string;
	trigger: AgentConflictResolutionTrigger;
	status: AgentConflictResolutionStatus;
	attempt: number;
	maxAttempts: number;
	timeoutMs: number;
	candidateSha: string;
	recoverySha: string;
	attemptedSha?: string;
	resolutionSha?: string;
	resolverSessionId?: string;
	branch?: string;
	worktreePath?: string;
	contextPath?: string;
	conflictFiles: string[];
	candidateChangedFiles: string[];
	inputGateResults: AgentIntegrationGateResult[];
	validationGateResults: AgentIntegrationGateResult[];
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	workspaceCleanedAt?: string;
	summary?: string;
	error?: string;
}

export interface AgentConflictResolverContext {
	resolutionId: string;
	taskId: string;
	trigger: AgentConflictResolutionTrigger;
	attempt: number;
	maxAttempts: number;
	timeoutMs: number;
	candidateSha: string;
	recoverySha: string;
	attemptedSha?: string;
	workspace: AgentConflictResolutionWorkspace;
	conflictFiles: string[];
	candidateChangedFiles: string[];
	taskContracts: AgentRuntimeTaskContract[];
	inputGateResults: AgentIntegrationGateResult[];
	candidatePatch: string;
	prompt: string;
	signal: AbortSignal;
}

export interface AgentConflictResolverRunnerResult {
	summary: string;
	sessionId?: string;
}

export type AgentConflictResolverRunner = (
	context: AgentConflictResolverContext,
) => Promise<AgentConflictResolverRunnerResult>;

export interface AgentConflictResolutionRequest {
	resolutionId: string;
	taskId: string;
	trigger: AgentConflictResolutionTrigger;
	attempt: number;
	maxAttempts: number;
	timeoutMs: number;
	candidateSha: string;
	recoverySha: string;
	attemptedSha?: string;
	conflictFiles: string[];
	inputGateResults: AgentIntegrationGateResult[];
	taskContracts: AgentRuntimeTaskContract[];
	candidateWorkspace: AgentGitWorkspace;
	runner: AgentConflictResolverRunner;
	onPrepared: (workspace: AgentConflictResolutionWorkspace, candidateChangedFiles: string[]) => void;
}

export interface AgentConflictResolutionExecutionResult {
	outcome: "candidate" | "failed" | "timed_out";
	workspace: AgentConflictResolutionWorkspace;
	candidateChangedFiles: string[];
	resolutionSha?: string;
	resolverSessionId?: string;
	summary?: string;
	error?: string;
}

export interface CreateAgentConflictResolverManagerOptions {
	runId: string;
	preferredRoot: string;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const CONTEXT_PATCH_LIMIT = 64 * 1024;

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
	return new Promise((resolvePromise) => {
		execFile(
			command,
			args,
			{ cwd, encoding: "utf8", maxBuffer: OUTPUT_LIMIT, windowsHide: true },
			(error, stdout, stderr) => {
				const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				resolvePromise({
					code,
					stdout: String(stdout),
					stderr: String(stderr) || (stdout ? "" : (error?.message ?? "")),
				});
			},
		);
	});
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const result = await runCommand("git", args, cwd);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
	}
	return result.stdout;
}

function canonicalPath(path: string): string {
	const resolved = resolve(path);
	let canonical = resolved;
	try {
		canonical = realpathSync.native(resolved);
	} catch {
		canonical = resolved;
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isWithin(parentPath: string, candidatePath: string): boolean {
	const pathFromParent = relative(canonicalPath(parentPath), canonicalPath(candidatePath));
	return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function sanitizeIdentifier(value: string, fallback: string): string {
	const sanitized = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 48);
	return sanitized || fallback;
}

function splitNullOutput(output: string): string[] {
	return output.split("\0").filter(Boolean).sort();
}

function truncateContext(value: string): string {
	if (value.length <= CONTEXT_PATCH_LIMIT) return value;
	return `${value.slice(0, CONTEXT_PATCH_LIMIT)}\n[candidate patch truncated by scheduler]\n`;
}

function cloneGateResult(result: AgentIntegrationGateResult): AgentIntegrationGateResult {
	return { ...result, args: [...result.args] };
}

export class AgentConflictResolverManager {
	private readonly runId: string;
	private readonly preferredRoot: string;

	constructor(options: CreateAgentConflictResolverManagerOptions) {
		if (!options.runId.trim()) throw new Error("Agent conflict resolver runId must not be empty");
		this.runId = options.runId;
		this.preferredRoot = resolve(options.preferredRoot);
	}

	async execute(request: AgentConflictResolutionRequest): Promise<AgentConflictResolutionExecutionResult> {
		const candidateChangedFiles = splitNullOutput(
			await runGit(request.candidateWorkspace.repositoryRoot, [
				"diff",
				"--name-only",
				"-z",
				request.recoverySha,
				request.candidateSha,
			]),
		);
		const candidatePatch = truncateContext(
			await runGit(request.candidateWorkspace.repositoryRoot, [
				"diff",
				"--no-ext-diff",
				"--find-renames",
				"--unified=80",
				request.recoverySha,
				request.candidateSha,
				"--",
			]),
		);
		const workspace = await this.prepareWorkspace(request, candidateChangedFiles);
		const prompt = this.formatPrompt(request, workspace, candidateChangedFiles, candidatePatch);
		writeFileSync(
			workspace.contextPath,
			`${JSON.stringify(
				{
					resolutionId: request.resolutionId,
					taskId: request.taskId,
					trigger: request.trigger,
					attempt: request.attempt,
					maxAttempts: request.maxAttempts,
					candidateSha: request.candidateSha,
					recoverySha: request.recoverySha,
					attemptedSha: request.attemptedSha,
					conflictFiles: request.conflictFiles,
					candidateChangedFiles,
					taskContracts: request.taskContracts,
					inputGateResults: request.inputGateResults.map(cloneGateResult),
					candidatePatch,
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		const controller = new AbortController();
		let timeout: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				controller.abort();
				reject(new Error(`Conflict resolver timed out after ${request.timeoutMs}ms`));
			}, request.timeoutMs);
		});
		let runnerResult: AgentConflictResolverRunnerResult;
		try {
			runnerResult = await Promise.race([
				request.runner({
					resolutionId: request.resolutionId,
					taskId: request.taskId,
					trigger: request.trigger,
					attempt: request.attempt,
					maxAttempts: request.maxAttempts,
					timeoutMs: request.timeoutMs,
					candidateSha: request.candidateSha,
					recoverySha: request.recoverySha,
					attemptedSha: request.attemptedSha,
					workspace,
					conflictFiles: [...request.conflictFiles],
					candidateChangedFiles,
					taskContracts: request.taskContracts.map((contract) => ({
						...contract,
						acceptanceCriteria: [...contract.acceptanceCriteria],
						expectedOutputs: [...contract.expectedOutputs],
					})),
					inputGateResults: request.inputGateResults.map(cloneGateResult),
					candidatePatch,
					prompt,
					signal: controller.signal,
				}),
				timeoutPromise,
			]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				outcome: controller.signal.aborted ? "timed_out" : "failed",
				workspace,
				candidateChangedFiles,
				error: message,
			};
		} finally {
			if (timeout) clearTimeout(timeout);
		}

		const diffCheck = await runCommand("git", ["diff", "--check"], workspace.worktreePath);
		if (diffCheck.code !== 0) {
			return {
				outcome: "failed",
				workspace,
				candidateChangedFiles,
				resolverSessionId: runnerResult.sessionId,
				summary: runnerResult.summary,
				error: `Resolver output failed git diff --check: ${diffCheck.stderr.trim() || diffCheck.stdout.trim()}`,
			};
		}
		await runGit(workspace.worktreePath, ["add", "-A", "--", "."]);
		const unresolvedFiles = splitNullOutput(
			await runGit(workspace.worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]),
		);
		if (unresolvedFiles.length > 0) {
			return {
				outcome: "failed",
				workspace,
				candidateChangedFiles,
				resolverSessionId: runnerResult.sessionId,
				summary: runnerResult.summary,
				error: `Resolver left unmerged files: ${unresolvedFiles.join(", ")}`,
			};
		}
		const staged = await runGit(workspace.worktreePath, ["diff", "--cached", "--name-only", "-z"]);
		const mergeHeadExists =
			(await runCommand("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], workspace.worktreePath)).code === 0;
		if (staged.length > 0 || mergeHeadExists) {
			await runGit(workspace.worktreePath, [
				"-c",
				"user.name=Prime Agent Conflict Resolver",
				"-c",
				"user.email=conflict-resolver@prime-agent.local",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--no-gpg-sign",
				"-m",
				`prime-agent resolve ${request.taskId} attempt ${request.attempt}`,
			]);
		}
		const resolutionSha = (await runGit(workspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
		return {
			outcome: "candidate",
			workspace,
			candidateChangedFiles,
			resolutionSha,
			resolverSessionId: runnerResult.sessionId,
			summary: runnerResult.summary,
		};
	}

	async cleanupSuccessful(workspace: AgentConflictResolutionWorkspace): Promise<void> {
		this.assertOwnedWorkspace(workspace);
		if (!existsSync(workspace.worktreePath)) return;
		await runGit(workspace.repositoryRoot, ["worktree", "remove", "--force", "--", workspace.worktreePath]);
	}

	private async prepareWorkspace(
		request: AgentConflictResolutionRequest,
		candidateChangedFiles: string[],
	): Promise<AgentConflictResolutionWorkspace> {
		const repositoryRoot = request.candidateWorkspace.repositoryRoot;
		const repositoryId = request.candidateWorkspace.repositoryId;
		const taskSegment = sanitizeIdentifier(request.taskId, "task");
		const resolutionSegment = sanitizeIdentifier(request.resolutionId, "resolution");
		const branch = `prime-agent/${sanitizeIdentifier(this.runId, "run")}/resolver/${taskSegment}-${request.attempt}-${resolutionSegment.slice(-8)}`;
		const attemptRoot = join(this.preferredRoot, repositoryId, taskSegment, resolutionSegment);
		const worktreePath = join(attemptRoot, "worktree");
		const contextPath = join(attemptRoot, "conflict-context.json");
		if (existsSync(worktreePath)) {
			throw new Error(`Conflict resolver worktree already exists: ${worktreePath}`);
		}
		mkdirSync(dirname(worktreePath), { recursive: true });
		await runGit(repositoryRoot, ["check-ref-format", "--branch", branch]);
		const startSha = request.trigger === "quality_gate_failure" ? request.attemptedSha : request.recoverySha;
		if (!startSha) throw new Error("Quality-gate conflict resolution requires the attempted integration commit");
		await runGit(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, startSha]);
		const workspace = { repositoryId, repositoryRoot, branch, worktreePath, contextPath };
		request.onPrepared(workspace, candidateChangedFiles);
		if (request.trigger === "git_conflict") {
			const merge = await runCommand("git", ["merge", "--no-ff", "--no-commit", request.candidateSha], worktreePath);
			if (merge.code !== 0) {
				const conflicts = splitNullOutput(
					await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]),
				);
				if (conflicts.length === 0) {
					throw new Error(merge.stderr.trim() || merge.stdout.trim() || "Failed to recreate merge conflict");
				}
			}
		}
		return workspace;
	}

	private formatPrompt(
		request: AgentConflictResolutionRequest,
		workspace: AgentConflictResolutionWorkspace,
		candidateChangedFiles: string[],
		candidatePatch: string,
	): string {
		const contracts = request.taskContracts
			.map(
				(contract) =>
					`- task ${contract.taskId}: ${contract.objective}\n  acceptance: ${contract.acceptanceCriteria.join("; ") || "not declared"}\n  candidate branch: ${contract.branch}`,
			)
			.join("\n");
		const gates = request.inputGateResults
			.filter((gate) => !gate.passed)
			.map((gate) => `- ${gate.id}: ${gate.stderr || gate.stdout || `exit ${String(gate.exitCode)}`}`)
			.join("\n");
		return [
			"[agent runtime conflict resolution task]",
			`resolution_id: ${request.resolutionId}`,
			`attempt: ${request.attempt}/${request.maxAttempts}`,
			`trigger: ${request.trigger}`,
			`worktree: ${workspace.worktreePath}`,
			`context_file: ${workspace.contextPath}`,
			"",
			"Resolve the integration conflict in this isolated resolver worktree.",
			"Do not modify either worker branch or the integration worktree.",
			"Preserve the intent and acceptance criteria of every task contract.",
			"Remove all conflict markers and leave the resolver worktree ready for validation.",
			"The host will commit the result and rerun every configured integration quality gate.",
			"",
			"Task contracts:",
			contracts || "- no persisted contracts available",
			"",
			`Conflict files: ${request.conflictFiles.join(", ") || "none"}`,
			`Candidate changed files: ${candidateChangedFiles.join(", ") || "none"}`,
			"Failed gate evidence:",
			gates || "- none",
			"",
			"Candidate patch:",
			candidatePatch || "[no textual candidate diff]",
		].join("\n");
	}

	private assertOwnedWorkspace(workspace: AgentConflictResolutionWorkspace): void {
		const repositoryRoot = resolve(this.preferredRoot, workspace.repositoryId);
		if (!isWithin(this.preferredRoot, repositoryRoot) || !isWithin(repositoryRoot, workspace.worktreePath)) {
			throw new Error(`Resolver worktree is outside the scheduler-owned root: ${workspace.worktreePath}`);
		}
	}
}
