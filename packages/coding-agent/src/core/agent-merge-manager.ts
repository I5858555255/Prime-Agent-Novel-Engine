import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentGitWorkspace } from "./agent-git-worktree.js";

export interface AgentIntegrationQualityGate {
	id: string;
	command: string;
	args?: string[];
	timeoutMs?: number;
	shell?: boolean;
}

export interface AgentIntegrationGateResult {
	id: string;
	command: string;
	args: string[];
	passed: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface AgentIntegrationWorkspace {
	repositoryId: string;
	repositoryRoot: string;
	branch: string;
	worktreePath: string;
	headSha: string;
}

export type AgentMergeOutcome = "integrated" | "conflict" | "failed";

export interface AgentMergeResult {
	outcome: AgentMergeOutcome;
	integrationWorkspace: AgentIntegrationWorkspace;
	recoverySha: string;
	resultSha?: string;
	attemptedSha?: string;
	changedFiles: string[];
	conflictFiles: string[];
	gateResults: AgentIntegrationGateResult[];
	error?: string;
}

export interface AgentMergeRequest {
	taskId: string;
	candidateSha: string;
	candidateWorkspace: AgentGitWorkspace;
	integrationWorkspace?: AgentIntegrationWorkspace;
	recoverySha?: string;
	qualityGates: AgentIntegrationQualityGate[];
	onPrepared: (workspace: AgentIntegrationWorkspace, recoverySha: string) => void;
}

export interface AgentResolutionMergeRequest {
	taskId: string;
	candidateSha: string;
	resolutionSha: string;
	recoverySha: string;
	candidateWorkspace: AgentGitWorkspace;
	integrationWorkspace: AgentIntegrationWorkspace;
	qualityGates: AgentIntegrationQualityGate[];
}

export interface CreateAgentMergeManagerOptions {
	runId: string;
	preferredRoot: string;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000;

function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs?: number; shell?: boolean },
): Promise<CommandResult> {
	return new Promise((resolvePromise) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd,
				encoding: "utf8",
				maxBuffer: OUTPUT_LIMIT,
				shell: options.shell,
				timeout: options.timeoutMs,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
				resolvePromise({
					code: exitCode,
					stdout: String(stdout),
					stderr: String(stderr) || (error?.message ?? ""),
				});
			},
		);
	});
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const result = await runCommand("git", args, { cwd });
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

export class AgentMergeManager {
	private readonly runId: string;
	private readonly preferredRoot: string;

	constructor(options: CreateAgentMergeManagerOptions) {
		if (!options.runId.trim()) throw new Error("Agent Merge Manager runId must not be empty");
		this.runId = options.runId;
		this.preferredRoot = resolve(options.preferredRoot);
	}

	async integrate(request: AgentMergeRequest): Promise<AgentMergeResult> {
		const integrationWorkspace = await this.ensureIntegrationWorkspace(request);
		if (request.recoverySha) {
			await this.restoreInterruptedAttempt(integrationWorkspace, request.recoverySha);
		}
		const recoverySha = (await runGit(integrationWorkspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
		integrationWorkspace.headSha = recoverySha;
		const recoveryRef = `refs/prime-agent/recovery/${sanitizeIdentifier(this.runId, "run")}/${sanitizeIdentifier(request.taskId, "task")}`;
		await runGit(integrationWorkspace.repositoryRoot, ["update-ref", recoveryRef, recoverySha]);
		request.onPrepared({ ...integrationWorkspace }, recoverySha);

		const candidateContainsBase = await this.isAncestor(
			integrationWorkspace.repositoryRoot,
			request.candidateWorkspace.baseSha,
			request.candidateSha,
		);
		if (!candidateContainsBase) {
			return this.failure(
				integrationWorkspace,
				recoverySha,
				"failed",
				"Candidate commit is not descended from its assigned base",
			);
		}
		const baseIsIntegrated = await this.isAncestor(
			integrationWorkspace.repositoryRoot,
			request.candidateWorkspace.baseSha,
			recoverySha,
		);
		if (!baseIsIntegrated) {
			return this.failure(
				integrationWorkspace,
				recoverySha,
				"conflict",
				"Candidate base is not an ancestor of the current integration head",
			);
		}
		if (await this.isAncestor(integrationWorkspace.repositoryRoot, request.candidateSha, recoverySha)) {
			return {
				outcome: "integrated",
				integrationWorkspace,
				recoverySha,
				resultSha: recoverySha,
				changedFiles: [],
				conflictFiles: [],
				gateResults: [],
			};
		}

		const cleanStatus = await runGit(integrationWorkspace.worktreePath, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
		if (cleanStatus.length > 0) {
			return this.failure(
				integrationWorkspace,
				recoverySha,
				"failed",
				"Integration worktree contains unexpected changes",
			);
		}

		try {
			const merge = await runCommand("git", ["merge", "--no-ff", "--no-commit", request.candidateSha], {
				cwd: integrationWorkspace.worktreePath,
			});
			if (merge.code !== 0) {
				const conflictFiles = splitNullOutput(
					await runGit(integrationWorkspace.worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]),
				);
				await this.abortMerge(integrationWorkspace.worktreePath);
				if (conflictFiles.length > 0) {
					return {
						outcome: "conflict",
						integrationWorkspace,
						recoverySha,
						changedFiles: [],
						conflictFiles,
						gateResults: [],
						error: merge.stderr.trim() || merge.stdout.trim() || "Git merge conflict",
					};
				}
				return this.failure(
					integrationWorkspace,
					recoverySha,
					"failed",
					merge.stderr.trim() || merge.stdout.trim() || "Git merge failed",
				);
			}

			const staged = await runGit(integrationWorkspace.worktreePath, ["diff", "--cached", "--name-only", "-z"]);
			if (staged.length > 0) {
				await runGit(integrationWorkspace.worktreePath, [
					"-c",
					"user.name=Prime Agent Merge Manager",
					"-c",
					"user.email=merge-manager@prime-agent.local",
					"-c",
					"commit.gpgsign=false",
					"commit",
					"--no-gpg-sign",
					"-m",
					`prime-agent integrate ${request.taskId}`,
				]);
			}
			const resultSha = (await runGit(integrationWorkspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
			const changedFiles = splitNullOutput(
				await runGit(integrationWorkspace.worktreePath, ["diff", "--name-only", "-z", recoverySha, resultSha]),
			);
			const gateResults = await this.runQualityGates(request, resultSha);
			const failedGate = gateResults.find((gate) => !gate.passed);
			if (failedGate) {
				await this.restoreRecoveryPoint(integrationWorkspace, recoverySha, resultSha);
				return {
					outcome: "failed",
					integrationWorkspace: { ...integrationWorkspace, headSha: recoverySha },
					recoverySha,
					attemptedSha: resultSha,
					changedFiles,
					conflictFiles: [],
					gateResults,
					error: `Integration quality gate failed: ${failedGate.id}`,
				};
			}

			integrationWorkspace.headSha = resultSha;
			return {
				outcome: "integrated",
				integrationWorkspace,
				recoverySha,
				resultSha,
				changedFiles,
				conflictFiles: [],
				gateResults,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				await this.restoreFailedAttempt(integrationWorkspace, recoverySha);
			} catch (recoveryError) {
				const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
				throw new Error(`${message}; integration recovery failed: ${recoveryMessage}`);
			}
			return this.failure(integrationWorkspace, recoverySha, "failed", message);
		}
	}

	async integrateResolution(request: AgentResolutionMergeRequest): Promise<AgentMergeResult> {
		const integrationWorkspace = { ...request.integrationWorkspace };
		this.assertOwnedIntegrationPath(integrationWorkspace);
		if (integrationWorkspace.repositoryId !== request.candidateWorkspace.repositoryId) {
			throw new Error("Resolution and candidate repository identities do not match");
		}
		if (
			canonicalPath(integrationWorkspace.repositoryRoot) !== canonicalPath(request.candidateWorkspace.repositoryRoot)
		) {
			throw new Error("Resolution and candidate repository roots do not match");
		}
		if (!existsSync(integrationWorkspace.worktreePath)) {
			throw new Error(`Persisted integration worktree is missing: ${integrationWorkspace.worktreePath}`);
		}
		const checkedOutBranch = (await runGit(integrationWorkspace.worktreePath, ["branch", "--show-current"])).trim();
		if (checkedOutBranch !== integrationWorkspace.branch) {
			throw new Error(`Integration worktree branch changed from ${integrationWorkspace.branch}`);
		}
		const currentSha = (await runGit(integrationWorkspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
		if (currentSha !== request.recoverySha) {
			throw new Error("Integration head changed while conflict resolution was running");
		}
		if (
			!(await this.isAncestor(integrationWorkspace.repositoryRoot, request.recoverySha, request.resolutionSha)) ||
			!(await this.isAncestor(integrationWorkspace.repositoryRoot, request.candidateSha, request.resolutionSha))
		) {
			throw new Error("Resolution commit must contain both the recovery head and candidate commit");
		}
		const cleanStatus = await runGit(integrationWorkspace.worktreePath, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
		if (cleanStatus.length > 0) {
			throw new Error("Integration worktree contains unexpected changes before resolution promotion");
		}
		const changedFiles = splitNullOutput(
			await runGit(integrationWorkspace.repositoryRoot, [
				"diff",
				"--name-only",
				"-z",
				request.recoverySha,
				request.resolutionSha,
			]),
		);
		const gateResults = await this.runQualityGates(
			{
				taskId: request.taskId,
				candidateWorkspace: request.candidateWorkspace,
				qualityGates: request.qualityGates,
			},
			request.resolutionSha,
		);
		const failedGate = gateResults.find((gate) => !gate.passed);
		if (failedGate) {
			return {
				outcome: "failed",
				integrationWorkspace,
				recoverySha: request.recoverySha,
				attemptedSha: request.resolutionSha,
				changedFiles,
				conflictFiles: [],
				gateResults,
				error: `Conflict resolution quality gate failed: ${failedGate.id}`,
			};
		}

		let advanced = false;
		try {
			await runGit(integrationWorkspace.repositoryRoot, [
				"update-ref",
				`refs/heads/${integrationWorkspace.branch}`,
				request.resolutionSha,
				request.recoverySha,
			]);
			advanced = true;
			await runGit(integrationWorkspace.worktreePath, ["read-tree", "--reset", "-u", request.resolutionSha]);
			const promotedSha = (await runGit(integrationWorkspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
			if (promotedSha !== request.resolutionSha) {
				throw new Error("Conflict resolution promotion did not update the integration worktree");
			}
			integrationWorkspace.headSha = request.resolutionSha;
			return {
				outcome: "integrated",
				integrationWorkspace,
				recoverySha: request.recoverySha,
				resultSha: request.resolutionSha,
				changedFiles,
				conflictFiles: [],
				gateResults,
			};
		} catch (error) {
			if (advanced) {
				await this.restoreRecoveryPoint(integrationWorkspace, request.recoverySha, request.resolutionSha);
			}
			throw error;
		}
	}

	private async ensureIntegrationWorkspace(request: AgentMergeRequest): Promise<AgentIntegrationWorkspace> {
		if (request.integrationWorkspace) {
			this.assertOwnedIntegrationPath(request.integrationWorkspace);
			if (request.integrationWorkspace.repositoryId !== request.candidateWorkspace.repositoryId) {
				throw new Error("Integration and candidate repository identities do not match");
			}
			if (
				canonicalPath(request.integrationWorkspace.repositoryRoot) !==
				canonicalPath(request.candidateWorkspace.repositoryRoot)
			) {
				throw new Error("Integration and candidate repository roots do not match");
			}
			if (!existsSync(request.integrationWorkspace.worktreePath)) {
				throw new Error(`Persisted integration worktree is missing: ${request.integrationWorkspace.worktreePath}`);
			}
			const branch = (await runGit(request.integrationWorkspace.worktreePath, ["branch", "--show-current"])).trim();
			if (branch !== request.integrationWorkspace.branch) {
				throw new Error(`Integration worktree branch changed from ${request.integrationWorkspace.branch}`);
			}
			return { ...request.integrationWorkspace };
		}

		const repositoryRoot = request.candidateWorkspace.repositoryRoot;
		const repositoryId = request.candidateWorkspace.repositoryId;
		const runSegment = sanitizeIdentifier(this.runId, "run");
		const branch = `prime-agent/${runSegment}/integration`;
		const integrationRoot = join(this.preferredRoot, repositoryId);
		const worktreePath = join(integrationRoot, "integration");
		if (existsSync(worktreePath)) {
			throw new Error(`Integration worktree path already exists without scheduler state: ${worktreePath}`);
		}
		mkdirSync(integrationRoot, { recursive: true });
		await runGit(repositoryRoot, ["check-ref-format", "--branch", branch]);
		await runGit(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, request.candidateWorkspace.baseSha]);
		return {
			repositoryId,
			repositoryRoot,
			branch,
			worktreePath,
			headSha: request.candidateWorkspace.baseSha,
		};
	}

	async validateWorkspace(
		workspacePath: string,
		qualityGates: readonly AgentIntegrationQualityGate[],
	): Promise<AgentIntegrationGateResult[]> {
		const results: AgentIntegrationGateResult[] = [];
		for (const gate of qualityGates) {
			const startedAt = Date.now();
			const commandResult = await runCommand(gate.command, [...(gate.args ?? [])], {
				cwd: workspacePath,
				timeoutMs: gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
				shell: gate.shell,
			});
			results.push({
				id: gate.id,
				command: gate.command,
				args: [...(gate.args ?? [])],
				passed: commandResult.code === 0,
				exitCode: commandResult.code,
				stdout: commandResult.stdout,
				stderr: commandResult.stderr,
				durationMs: Date.now() - startedAt,
			});
			if (commandResult.code !== 0) break;
		}
		return results;
	}

	private async runQualityGates(
		request: Pick<AgentMergeRequest, "taskId" | "candidateWorkspace" | "qualityGates">,
		resultSha: string,
	): Promise<AgentIntegrationGateResult[]> {
		if (request.qualityGates.length === 0) return [];
		const gateRoot = join(
			this.preferredRoot,
			request.candidateWorkspace.repositoryId,
			"gates",
			`${sanitizeIdentifier(request.taskId, "task")}-${createHash("sha256").update(resultSha).digest("hex").slice(0, 8)}`,
		);
		if (existsSync(gateRoot)) throw new Error(`Integration gate worktree already exists: ${gateRoot}`);
		mkdirSync(dirname(gateRoot), { recursive: true });
		await runGit(request.candidateWorkspace.repositoryRoot, ["worktree", "add", "--detach", gateRoot, resultSha]);
		try {
			return await this.validateWorkspace(gateRoot, request.qualityGates);
		} finally {
			await runGit(request.candidateWorkspace.repositoryRoot, ["worktree", "remove", "--force", "--", gateRoot]);
		}
	}

	private async restoreRecoveryPoint(
		workspace: AgentIntegrationWorkspace,
		recoverySha: string,
		attemptedSha: string,
	): Promise<void> {
		await runGit(workspace.repositoryRoot, [
			"update-ref",
			`refs/heads/${workspace.branch}`,
			recoverySha,
			attemptedSha,
		]);
		await runGit(workspace.worktreePath, ["read-tree", "--reset", "-u", recoverySha]);
		const restoredSha = (await runGit(workspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
		if (restoredSha !== recoverySha) throw new Error("Integration recovery point restoration failed");
	}

	private async restoreInterruptedAttempt(workspace: AgentIntegrationWorkspace, recoverySha: string): Promise<void> {
		await this.abortMerge(workspace.worktreePath);
		const currentSha = (await runGit(workspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
		if (currentSha === recoverySha) return;
		await runGit(workspace.repositoryRoot, ["update-ref", `refs/heads/${workspace.branch}`, recoverySha, currentSha]);
		await runGit(workspace.worktreePath, ["read-tree", "--reset", "-u", recoverySha]);
	}

	private async restoreFailedAttempt(workspace: AgentIntegrationWorkspace, recoverySha: string): Promise<void> {
		await this.abortMerge(workspace.worktreePath);
		const currentSha = (await runGit(workspace.worktreePath, ["rev-parse", "HEAD^{commit}"])).trim();
		if (currentSha !== recoverySha) {
			await this.restoreRecoveryPoint(workspace, recoverySha, currentSha);
		}
		workspace.headSha = recoverySha;
	}

	private async abortMerge(worktreePath: string): Promise<void> {
		const abort = await runCommand("git", ["merge", "--abort"], { cwd: worktreePath });
		if (abort.code === 0) return;
		const status = await runGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
		if (status.length > 0) throw new Error(`Failed to abort integration merge: ${abort.stderr.trim()}`);
	}

	private async isAncestor(repositoryRoot: string, ancestor: string, descendant: string): Promise<boolean> {
		const result = await runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
			cwd: repositoryRoot,
		});
		return result.code === 0;
	}

	private failure(
		workspace: AgentIntegrationWorkspace,
		recoverySha: string,
		outcome: "conflict" | "failed",
		error: string,
	): AgentMergeResult {
		return {
			outcome,
			integrationWorkspace: workspace,
			recoverySha,
			changedFiles: [],
			conflictFiles: [],
			gateResults: [],
			error,
		};
	}

	private assertOwnedIntegrationPath(workspace: AgentIntegrationWorkspace): void {
		const repositoryRoot = resolve(this.preferredRoot, workspace.repositoryId);
		if (!isWithin(this.preferredRoot, repositoryRoot)) {
			throw new Error(`Invalid integration repository identity: ${workspace.repositoryId}`);
		}
		if (!isWithin(repositoryRoot, workspace.worktreePath)) {
			throw new Error(`Integration worktree is outside the scheduler-owned root: ${workspace.worktreePath}`);
		}
	}
}
