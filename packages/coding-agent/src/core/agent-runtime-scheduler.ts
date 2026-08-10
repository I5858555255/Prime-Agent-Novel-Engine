import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type AgentConflictResolutionRecord,
	type AgentConflictResolutionStatus,
	type AgentConflictResolutionTrigger,
	AgentConflictResolverManager,
	type AgentConflictResolverRunner,
} from "./agent-conflict-resolver.js";
import {
	type AgentGitWorkspace,
	AgentGitWorktreeManager,
	type AgentRuntimeResultManifest,
	type AgentRuntimeTaskContract,
	parseAgentRuntimeTaskContract,
} from "./agent-git-worktree.js";
import {
	type AgentIntegrationGateResult,
	type AgentIntegrationQualityGate,
	type AgentIntegrationWorkspace,
	AgentMergeManager,
	type AgentMergeOutcome,
} from "./agent-merge-manager.js";

export const AGENT_RUNTIME_SCHEDULER_STATE_VERSION = 5;
const PREVIOUS_AGENT_RUNTIME_SCHEDULER_STATE_VERSION = 4;
const LEGACY_AGENT_RUNTIME_SCHEDULER_STATE_VERSION = 3;

export type AgentRuntimeTaskStatus =
	| "planned"
	| "queued"
	| "preparing_workspace"
	| "running"
	| "completed"
	| "integrating"
	| "integrated"
	| "conflict"
	| "failed"
	| "cancelled";

export type AgentRuntimeAgentStatus = "admitted" | "running" | "recovering" | "completed" | "failed" | "cancelled";

export interface AgentRuntimeTaskRecord {
	id: string;
	objective: string;
	dependencies: string[];
	resources: string[];
	status: AgentRuntimeTaskStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface AgentRuntimeAgentRecord {
	id: string;
	taskId: string;
	parentAgentId?: string;
	sessionId?: string;
	sessionName?: string;
	status: AgentRuntimeAgentStatus;
	createdAt: string;
	updatedAt: string;
	heartbeatAt?: string;
	error?: string;
	repositoryId?: string;
	repositoryRoot?: string;
	gitCommonDir?: string;
	baseSha?: string;
	branch?: string;
	worktreePath?: string;
	taskContractPath?: string;
	resultManifestPath?: string;
	candidateSha?: string;
	worktreeCleanedAt?: string;
}

export interface AgentRuntimeSchedulerSnapshot {
	version: typeof AGENT_RUNTIME_SCHEDULER_STATE_VERSION;
	workspaceId: string;
	runId: string;
	createdAt: string;
	updatedAt: string;
	tasks: AgentRuntimeTaskRecord[];
	agents: AgentRuntimeAgentRecord[];
	integrationRecords: AgentRuntimeIntegrationRecord[];
	integrationWorkspaces: AgentIntegrationWorkspace[];
	resourceLeases: AgentRuntimeResourceLease[];
	resourceBlocks: AgentRuntimeResourceBlockRecord[];
	conflictResolutions: AgentConflictResolutionRecord[];
	events: AgentRuntimeSchedulerEvent[];
	nextEventSequence: number;
}

export type AgentRuntimeIntegrationStatus = "queued" | "integrating" | AgentMergeOutcome;

export interface AgentRuntimeIntegrationRecord {
	taskId: string;
	agentId: string;
	repositoryId: string;
	baseSha: string;
	candidateSha: string;
	status: AgentRuntimeIntegrationStatus;
	queuedAt: string;
	startedAt?: string;
	completedAt?: string;
	recoverySha?: string;
	resultSha?: string;
	attemptedSha?: string;
	changedFiles: string[];
	conflictFiles: string[];
	gateResults: AgentIntegrationGateResult[];
	error?: string;
}

export type AgentRuntimeResourceLeaseStatus = "active" | "released" | "expired";

export type AgentRuntimeResourceReleaseReason =
	| "agent_completed"
	| "agent_failed"
	| "agent_cancelled"
	| "explicit"
	| "lease_expired";

export interface AgentRuntimeResourceLease {
	id: string;
	scope: string;
	mode: "exclusive";
	taskId: string;
	agentId: string;
	epoch: number;
	status: AgentRuntimeResourceLeaseStatus;
	acquiredAt: string;
	heartbeatAt: string;
	expiresAt: string;
	releasedAt?: string;
	releaseReason?: AgentRuntimeResourceReleaseReason;
}

export interface AgentRuntimeResourceConflict {
	scope: string;
	leaseId: string;
	ownerTaskId: string;
	ownerAgentId: string;
	expiresAt: string;
}

export interface AgentRuntimeResourceBlockRecord {
	id: string;
	taskId: string;
	agentId: string;
	resources: string[];
	conflicts: AgentRuntimeResourceConflict[];
	detectedAt: string;
	resolvedAt?: string;
}

export interface AgentRuntimeResourceAcquisitionResult {
	acquired: boolean;
	leases: AgentRuntimeResourceLease[];
	conflicts: AgentRuntimeResourceConflict[];
}

export interface AgentRuntimeTaskResourceSummary {
	taskId: string;
	resources: string[];
	ownedResources: string[];
}

export type AgentRuntimeSchedulerEventType =
	| "task_registered"
	| "task_status_changed"
	| "agent_admitted"
	| "agent_started"
	| "agent_heartbeat"
	| "agent_completed"
	| "agent_failed"
	| "agent_cancelled"
	| "integration_queued"
	| "integration_started"
	| "integration_completed"
	| "integration_conflicted"
	| "integration_failed"
	| "resource_acquired"
	| "resource_released"
	| "resource_blocked"
	| "resource_expired"
	| "resolution_queued"
	| "resolution_started"
	| "resolution_succeeded"
	| "resolution_retrying"
	| "resolution_escalated";

export interface AgentRuntimeSchedulerEvent {
	id: string;
	sequence: number;
	type: AgentRuntimeSchedulerEventType;
	occurredAt: string;
	taskId?: string;
	agentId?: string;
	resolutionId?: string;
	previousStatus?: AgentRuntimeTaskStatus | AgentRuntimeAgentStatus;
	status?: AgentRuntimeTaskStatus | AgentRuntimeAgentStatus;
	resourceScopes: string[];
	leaseIds: string[];
	conflicts: AgentRuntimeResourceConflict[];
	message?: string;
}

export type AgentRuntimeSchedulerEventListener = (event: AgentRuntimeSchedulerEvent) => void | Promise<void>;

type AgentRuntimeSchedulerEventInput = Omit<
	AgentRuntimeSchedulerEvent,
	"id" | "sequence" | "occurredAt" | "resourceScopes" | "leaseIds" | "conflicts"
> &
	Partial<Pick<AgentRuntimeSchedulerEvent, "resourceScopes" | "leaseIds" | "conflicts">>;

export interface AgentRuntimeTaskReadiness {
	taskId: string;
	ready: boolean;
	blockedBy: string[];
}

export interface AgentRuntimeSchedulerSummary {
	workspaceId: string;
	runId: string;
	updatedAt: string;
	taskCounts: Partial<Record<AgentRuntimeTaskStatus, number>>;
	agentCounts: Partial<Record<AgentRuntimeAgentStatus, number>>;
	readyTaskIds: string[];
	blockedTaskIds: string[];
	activeAgents: AgentRuntimeAgentRecord[];
	workspaceAgents: AgentRuntimeAgentRecord[];
	integrationRecords: AgentRuntimeIntegrationRecord[];
	integrationWorkspaces: AgentIntegrationWorkspace[];
	activeResourceLeases: AgentRuntimeResourceLease[];
	blockedResourceTasks: AgentRuntimeResourceBlockRecord[];
	taskResources: AgentRuntimeTaskResourceSummary[];
	conflictResolutions: AgentConflictResolutionRecord[];
	recentEvents: AgentRuntimeSchedulerEvent[];
	latestEventSequence: number;
}

export interface CreateAgentRuntimeSchedulerOptions {
	workspacePath: string;
	runId: string;
	statePath?: string;
	now?: () => number;
	integrationQualityGates?: AgentIntegrationQualityGate[];
	resourceLeaseTtlMs?: number;
	conflictResolver?: AgentConflictResolverRunner;
	conflictResolutionMaxAttempts?: number;
	conflictResolutionTimeoutMs?: number;
}

export interface RegisterAgentRuntimeTaskInput {
	id: string;
	objective: string;
	dependencies?: string[];
	resources?: string[];
	status?: "planned" | "queued";
}

export interface RegisterAgentRuntimeAgentInput {
	id: string;
	taskId: string;
	parentAgentId?: string;
	sessionId?: string;
	sessionName?: string;
}

const TASK_STATUSES: readonly AgentRuntimeTaskStatus[] = [
	"planned",
	"queued",
	"preparing_workspace",
	"running",
	"completed",
	"integrating",
	"integrated",
	"conflict",
	"failed",
	"cancelled",
];

const AGENT_STATUSES: readonly AgentRuntimeAgentStatus[] = [
	"admitted",
	"running",
	"recovering",
	"completed",
	"failed",
	"cancelled",
];

const INTEGRATION_STATUSES: readonly AgentRuntimeIntegrationStatus[] = [
	"queued",
	"integrating",
	"integrated",
	"conflict",
	"failed",
];

const RESOURCE_LEASE_STATUSES: readonly AgentRuntimeResourceLeaseStatus[] = ["active", "released", "expired"];
const RESOURCE_RELEASE_REASONS: readonly AgentRuntimeResourceReleaseReason[] = [
	"agent_completed",
	"agent_failed",
	"agent_cancelled",
	"explicit",
	"lease_expired",
];
const SCHEDULER_EVENT_TYPES: readonly AgentRuntimeSchedulerEventType[] = [
	"task_registered",
	"task_status_changed",
	"agent_admitted",
	"agent_started",
	"agent_heartbeat",
	"agent_completed",
	"agent_failed",
	"agent_cancelled",
	"integration_queued",
	"integration_started",
	"integration_completed",
	"integration_conflicted",
	"integration_failed",
	"resource_acquired",
	"resource_released",
	"resource_blocked",
	"resource_expired",
	"resolution_queued",
	"resolution_started",
	"resolution_succeeded",
	"resolution_retrying",
	"resolution_escalated",
];
const CONFLICT_RESOLUTION_STATUSES: readonly AgentConflictResolutionStatus[] = [
	"queued",
	"running",
	"resolved",
	"failed",
	"timed_out",
	"escalated",
];
const CONFLICT_RESOLUTION_TRIGGERS: readonly AgentConflictResolutionTrigger[] = [
	"git_conflict",
	"quality_gate_failure",
];
const DEFAULT_RESOURCE_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CONFLICT_RESOLUTION_MAX_ATTEMPTS = 2;
const DEFAULT_CONFLICT_RESOLUTION_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_EVENT_INTERVAL_MS = 30 * 1000;
const MAX_PERSISTED_SCHEDULER_EVENTS = 512;
const MAX_SUMMARY_SCHEDULER_EVENTS = 32;

const TASK_TRANSITIONS: Readonly<Record<AgentRuntimeTaskStatus, ReadonlySet<AgentRuntimeTaskStatus>>> = {
	planned: new Set(["queued", "failed", "cancelled"]),
	queued: new Set(["preparing_workspace", "running", "failed", "cancelled"]),
	preparing_workspace: new Set(["running", "failed", "cancelled"]),
	running: new Set(["completed", "failed", "cancelled"]),
	completed: new Set(["integrating", "failed", "cancelled"]),
	integrating: new Set(["integrated", "conflict", "failed", "cancelled"]),
	integrated: new Set(),
	conflict: new Set(["integrating", "failed", "cancelled"]),
	failed: new Set(),
	cancelled: new Set(),
};

const AGENT_TRANSITIONS: Readonly<Record<AgentRuntimeAgentStatus, ReadonlySet<AgentRuntimeAgentStatus>>> = {
	admitted: new Set(["running", "recovering", "failed", "cancelled"]),
	running: new Set(["recovering", "completed", "failed", "cancelled"]),
	recovering: new Set(["running", "completed", "failed", "cancelled"]),
	completed: new Set(),
	failed: new Set(),
	cancelled: new Set(),
};

const READY_TASK_STATUSES = new Set<AgentRuntimeTaskStatus>(["planned", "queued"]);
const ACTIVE_AGENT_STATUSES = new Set<AgentRuntimeAgentStatus>(["admitted", "running", "recovering"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`Agent runtime scheduler state has invalid ${key}`);
	}
	return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value) {
		throw new Error(`Agent runtime scheduler state has invalid ${key}`);
	}
	return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
		throw new Error(`Agent runtime scheduler state has invalid ${key}`);
	}
	return [...value] as string[];
}

function parseTaskStatus(value: unknown): AgentRuntimeTaskStatus {
	if (!TASK_STATUSES.includes(value as AgentRuntimeTaskStatus)) {
		throw new Error("Agent runtime scheduler state has invalid task status");
	}
	return value as AgentRuntimeTaskStatus;
}

function parseAgentStatus(value: unknown): AgentRuntimeAgentStatus {
	if (!AGENT_STATUSES.includes(value as AgentRuntimeAgentStatus)) {
		throw new Error("Agent runtime scheduler state has invalid agent status");
	}
	return value as AgentRuntimeAgentStatus;
}

function parseIntegrationStatus(value: unknown): AgentRuntimeIntegrationStatus {
	if (!INTEGRATION_STATUSES.includes(value as AgentRuntimeIntegrationStatus)) {
		throw new Error("Agent runtime scheduler state has invalid integration status");
	}
	return value as AgentRuntimeIntegrationStatus;
}

function parseResourceLeaseStatus(value: unknown): AgentRuntimeResourceLeaseStatus {
	if (!RESOURCE_LEASE_STATUSES.includes(value as AgentRuntimeResourceLeaseStatus)) {
		throw new Error("Agent runtime scheduler state has invalid resource lease status");
	}
	return value as AgentRuntimeResourceLeaseStatus;
}

function parseResourceReleaseReason(value: unknown): AgentRuntimeResourceReleaseReason | undefined {
	if (value === undefined) return undefined;
	if (!RESOURCE_RELEASE_REASONS.includes(value as AgentRuntimeResourceReleaseReason)) {
		throw new Error("Agent runtime scheduler state has invalid resource release reason");
	}
	return value as AgentRuntimeResourceReleaseReason;
}

function parseSchedulerEventType(value: unknown): AgentRuntimeSchedulerEventType {
	if (!SCHEDULER_EVENT_TYPES.includes(value as AgentRuntimeSchedulerEventType)) {
		throw new Error("Agent runtime scheduler state has invalid event type");
	}
	return value as AgentRuntimeSchedulerEventType;
}

function parseTask(value: unknown): AgentRuntimeTaskRecord {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid task record");
	return {
		id: requiredString(value, "id"),
		objective: requiredString(value, "objective"),
		dependencies: stringArray(value, "dependencies"),
		resources: value.resources === undefined ? [] : stringArray(value, "resources"),
		status: parseTaskStatus(value.status),
		createdAt: requiredString(value, "createdAt"),
		updatedAt: requiredString(value, "updatedAt"),
		error: optionalString(value, "error"),
	};
}

function parseResourceConflict(value: unknown): AgentRuntimeResourceConflict {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid resource conflict");
	return {
		scope: requiredString(value, "scope"),
		leaseId: requiredString(value, "leaseId"),
		ownerTaskId: requiredString(value, "ownerTaskId"),
		ownerAgentId: requiredString(value, "ownerAgentId"),
		expiresAt: requiredString(value, "expiresAt"),
	};
}

function parseResourceLease(value: unknown): AgentRuntimeResourceLease {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid resource lease");
	if (value.mode !== "exclusive" || typeof value.epoch !== "number" || !Number.isInteger(value.epoch)) {
		throw new Error("Agent runtime scheduler state has invalid resource lease fields");
	}
	return {
		id: requiredString(value, "id"),
		scope: requiredString(value, "scope"),
		mode: "exclusive",
		taskId: requiredString(value, "taskId"),
		agentId: requiredString(value, "agentId"),
		epoch: value.epoch,
		status: parseResourceLeaseStatus(value.status),
		acquiredAt: requiredString(value, "acquiredAt"),
		heartbeatAt: requiredString(value, "heartbeatAt"),
		expiresAt: requiredString(value, "expiresAt"),
		releasedAt: optionalString(value, "releasedAt"),
		releaseReason: parseResourceReleaseReason(value.releaseReason),
	};
}

function parseResourceBlock(value: unknown): AgentRuntimeResourceBlockRecord {
	if (!isRecord(value) || !Array.isArray(value.conflicts)) {
		throw new Error("Agent runtime scheduler state has invalid resource block");
	}
	return {
		id: requiredString(value, "id"),
		taskId: requiredString(value, "taskId"),
		agentId: requiredString(value, "agentId"),
		resources: stringArray(value, "resources"),
		conflicts: value.conflicts.map(parseResourceConflict),
		detectedAt: requiredString(value, "detectedAt"),
		resolvedAt: optionalString(value, "resolvedAt"),
	};
}

function parseSchedulerEvent(value: unknown): AgentRuntimeSchedulerEvent {
	if (!isRecord(value) || !Array.isArray(value.conflicts)) {
		throw new Error("Agent runtime scheduler state has invalid event");
	}
	if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 1) {
		throw new Error("Agent runtime scheduler state has invalid event sequence");
	}
	const previousStatus = value.previousStatus === undefined ? undefined : parseStatus(value.previousStatus);
	const status = value.status === undefined ? undefined : parseStatus(value.status);
	return {
		id: requiredString(value, "id"),
		sequence: value.sequence,
		type: parseSchedulerEventType(value.type),
		occurredAt: requiredString(value, "occurredAt"),
		taskId: optionalString(value, "taskId"),
		agentId: optionalString(value, "agentId"),
		resolutionId: optionalString(value, "resolutionId"),
		previousStatus,
		status,
		resourceScopes: stringArray(value, "resourceScopes"),
		leaseIds: stringArray(value, "leaseIds"),
		conflicts: value.conflicts.map(parseResourceConflict),
		message: optionalString(value, "message"),
	};
}

function parseStatus(value: unknown): AgentRuntimeTaskStatus | AgentRuntimeAgentStatus {
	if (TASK_STATUSES.includes(value as AgentRuntimeTaskStatus)) return value as AgentRuntimeTaskStatus;
	return parseAgentStatus(value);
}

function parseAgent(value: unknown): AgentRuntimeAgentRecord {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid agent record");
	return {
		id: requiredString(value, "id"),
		taskId: requiredString(value, "taskId"),
		parentAgentId: optionalString(value, "parentAgentId"),
		sessionId: optionalString(value, "sessionId"),
		sessionName: optionalString(value, "sessionName"),
		status: parseAgentStatus(value.status),
		createdAt: requiredString(value, "createdAt"),
		updatedAt: requiredString(value, "updatedAt"),
		heartbeatAt: optionalString(value, "heartbeatAt"),
		error: optionalString(value, "error"),
		repositoryId: optionalString(value, "repositoryId"),
		repositoryRoot: optionalString(value, "repositoryRoot"),
		gitCommonDir: optionalString(value, "gitCommonDir"),
		baseSha: optionalString(value, "baseSha"),
		branch: optionalString(value, "branch"),
		worktreePath: optionalString(value, "worktreePath"),
		taskContractPath: optionalString(value, "taskContractPath"),
		resultManifestPath: optionalString(value, "resultManifestPath"),
		candidateSha: optionalString(value, "candidateSha"),
		worktreeCleanedAt: optionalString(value, "worktreeCleanedAt"),
	};
}

function parseGateResult(value: unknown): AgentIntegrationGateResult {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid gate result");
	const args = stringArray(value, "args");
	if (typeof value.passed !== "boolean" || typeof value.durationMs !== "number") {
		throw new Error("Agent runtime scheduler state has invalid gate result fields");
	}
	if (value.exitCode !== null && typeof value.exitCode !== "number") {
		throw new Error("Agent runtime scheduler state has invalid gate exitCode");
	}
	return {
		id: requiredString(value, "id"),
		command: requiredString(value, "command"),
		args,
		passed: value.passed,
		exitCode: value.exitCode,
		stdout: typeof value.stdout === "string" ? value.stdout : "",
		stderr: typeof value.stderr === "string" ? value.stderr : "",
		durationMs: value.durationMs,
	};
}

function parseIntegrationRecord(value: unknown): AgentRuntimeIntegrationRecord {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid integration record");
	if (!Array.isArray(value.gateResults)) {
		throw new Error("Agent runtime scheduler state has invalid integration gate results");
	}
	return {
		taskId: requiredString(value, "taskId"),
		agentId: requiredString(value, "agentId"),
		repositoryId: requiredString(value, "repositoryId"),
		baseSha: requiredString(value, "baseSha"),
		candidateSha: requiredString(value, "candidateSha"),
		status: parseIntegrationStatus(value.status),
		queuedAt: requiredString(value, "queuedAt"),
		startedAt: optionalString(value, "startedAt"),
		completedAt: optionalString(value, "completedAt"),
		recoverySha: optionalString(value, "recoverySha"),
		resultSha: optionalString(value, "resultSha"),
		attemptedSha: optionalString(value, "attemptedSha"),
		changedFiles: stringArray(value, "changedFiles"),
		conflictFiles: stringArray(value, "conflictFiles"),
		gateResults: value.gateResults.map(parseGateResult),
		error: optionalString(value, "error"),
	};
}

function parseIntegrationWorkspace(value: unknown): AgentIntegrationWorkspace {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state has invalid integration workspace");
	return {
		repositoryId: requiredString(value, "repositoryId"),
		repositoryRoot: requiredString(value, "repositoryRoot"),
		branch: requiredString(value, "branch"),
		worktreePath: requiredString(value, "worktreePath"),
		headSha: requiredString(value, "headSha"),
	};
}

function parseConflictResolutionStatus(value: unknown): AgentConflictResolutionStatus {
	if (!CONFLICT_RESOLUTION_STATUSES.includes(value as AgentConflictResolutionStatus)) {
		throw new Error("Agent runtime scheduler state has invalid conflict resolution status");
	}
	return value as AgentConflictResolutionStatus;
}

function parseConflictResolutionTrigger(value: unknown): AgentConflictResolutionTrigger {
	if (!CONFLICT_RESOLUTION_TRIGGERS.includes(value as AgentConflictResolutionTrigger)) {
		throw new Error("Agent runtime scheduler state has invalid conflict resolution trigger");
	}
	return value as AgentConflictResolutionTrigger;
}

function positiveInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`Agent runtime scheduler state has invalid ${key}`);
	}
	return value;
}

function parseConflictResolutionRecord(value: unknown): AgentConflictResolutionRecord {
	if (!isRecord(value) || !Array.isArray(value.inputGateResults) || !Array.isArray(value.validationGateResults)) {
		throw new Error("Agent runtime scheduler state has invalid conflict resolution record");
	}
	return {
		id: requiredString(value, "id"),
		taskId: requiredString(value, "taskId"),
		agentId: requiredString(value, "agentId"),
		repositoryId: requiredString(value, "repositoryId"),
		trigger: parseConflictResolutionTrigger(value.trigger),
		status: parseConflictResolutionStatus(value.status),
		attempt: positiveInteger(value, "attempt"),
		maxAttempts: positiveInteger(value, "maxAttempts"),
		timeoutMs: positiveInteger(value, "timeoutMs"),
		candidateSha: requiredString(value, "candidateSha"),
		recoverySha: requiredString(value, "recoverySha"),
		attemptedSha: optionalString(value, "attemptedSha"),
		resolutionSha: optionalString(value, "resolutionSha"),
		resolverSessionId: optionalString(value, "resolverSessionId"),
		branch: optionalString(value, "branch"),
		worktreePath: optionalString(value, "worktreePath"),
		contextPath: optionalString(value, "contextPath"),
		conflictFiles: stringArray(value, "conflictFiles"),
		candidateChangedFiles: stringArray(value, "candidateChangedFiles"),
		inputGateResults: value.inputGateResults.map(parseGateResult),
		validationGateResults: value.validationGateResults.map(parseGateResult),
		createdAt: requiredString(value, "createdAt"),
		startedAt: optionalString(value, "startedAt"),
		completedAt: optionalString(value, "completedAt"),
		workspaceCleanedAt: optionalString(value, "workspaceCleanedAt"),
		summary: optionalString(value, "summary"),
		error: optionalString(value, "error"),
	};
}

function parseSnapshot(value: unknown): AgentRuntimeSchedulerSnapshot {
	if (!isRecord(value)) throw new Error("Agent runtime scheduler state must be an object");
	const isPreviousVersion = value.version === PREVIOUS_AGENT_RUNTIME_SCHEDULER_STATE_VERSION;
	const isLegacyVersion = value.version === LEGACY_AGENT_RUNTIME_SCHEDULER_STATE_VERSION;
	if (!isLegacyVersion && !isPreviousVersion && value.version !== AGENT_RUNTIME_SCHEDULER_STATE_VERSION) {
		throw new Error(`Unsupported agent runtime scheduler state version: ${String(value.version)}`);
	}
	if (
		!Array.isArray(value.tasks) ||
		!Array.isArray(value.agents) ||
		!Array.isArray(value.integrationRecords) ||
		!Array.isArray(value.integrationWorkspaces) ||
		(!isLegacyVersion &&
			(!Array.isArray(value.resourceLeases) ||
				!Array.isArray(value.resourceBlocks) ||
				!Array.isArray(value.events))) ||
		(!isLegacyVersion && !isPreviousVersion && !Array.isArray(value.conflictResolutions))
	) {
		throw new Error("Agent runtime scheduler state has invalid registry arrays");
	}
	const snapshot: AgentRuntimeSchedulerSnapshot = {
		version: AGENT_RUNTIME_SCHEDULER_STATE_VERSION,
		workspaceId: requiredString(value, "workspaceId"),
		runId: requiredString(value, "runId"),
		createdAt: requiredString(value, "createdAt"),
		updatedAt: requiredString(value, "updatedAt"),
		tasks: value.tasks.map(parseTask),
		agents: value.agents.map(parseAgent),
		integrationRecords: value.integrationRecords.map(parseIntegrationRecord),
		integrationWorkspaces: value.integrationWorkspaces.map(parseIntegrationWorkspace),
		resourceLeases: isLegacyVersion ? [] : (value.resourceLeases as unknown[]).map(parseResourceLease),
		resourceBlocks: isLegacyVersion ? [] : (value.resourceBlocks as unknown[]).map(parseResourceBlock),
		conflictResolutions:
			isLegacyVersion || isPreviousVersion
				? []
				: (value.conflictResolutions as unknown[]).map(parseConflictResolutionRecord),
		events: isLegacyVersion ? [] : (value.events as unknown[]).map(parseSchedulerEvent),
		nextEventSequence: isLegacyVersion ? 1 : parseNextEventSequence(value.nextEventSequence),
	};
	assertUniqueIds(snapshot.tasks, "task");
	assertUniqueIds(snapshot.agents, "agent");
	assertUniqueIds(
		snapshot.integrationRecords.map((record) => ({ id: record.taskId })),
		"integration task",
	);
	assertUniqueIds(
		snapshot.integrationWorkspaces.map((workspace) => ({ id: workspace.repositoryId })),
		"integration repository",
	);
	assertUniqueIds(snapshot.resourceLeases, "resource lease");
	assertUniqueIds(snapshot.resourceBlocks, "resource block");
	assertUniqueIds(snapshot.conflictResolutions, "conflict resolution");
	assertUniqueIds(snapshot.events, "scheduler event");
	const highestEventSequence = snapshot.events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
	if (snapshot.nextEventSequence <= highestEventSequence) {
		throw new Error("Agent runtime scheduler state has invalid next event sequence");
	}
	return snapshot;
}

function parseNextEventSequence(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error("Agent runtime scheduler state has invalid next event sequence");
	}
	return value;
}

function assertUniqueIds(records: Array<{ id: string }>, kind: string): void {
	const ids = new Set<string>();
	for (const record of records) {
		if (ids.has(record.id)) throw new Error(`Duplicate ${kind} id in agent runtime scheduler state: ${record.id}`);
		ids.add(record.id);
	}
}

function canonicalWorkspaceId(workspacePath: string): string {
	const resolved = resolve(workspacePath);
	let canonical = resolved;
	try {
		canonical = realpathSync.native(resolved);
	} catch {
		canonical = resolved;
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function cloneTask(task: AgentRuntimeTaskRecord): AgentRuntimeTaskRecord {
	return { ...task, dependencies: [...task.dependencies], resources: [...task.resources] };
}

function cloneAgent(agent: AgentRuntimeAgentRecord): AgentRuntimeAgentRecord {
	return { ...agent };
}

function cloneIntegrationRecord(record: AgentRuntimeIntegrationRecord): AgentRuntimeIntegrationRecord {
	return {
		...record,
		changedFiles: [...record.changedFiles],
		conflictFiles: [...record.conflictFiles],
		gateResults: record.gateResults.map((gate) => ({ ...gate, args: [...gate.args] })),
	};
}

function cloneResourceConflict(conflict: AgentRuntimeResourceConflict): AgentRuntimeResourceConflict {
	return { ...conflict };
}

function cloneResourceLease(lease: AgentRuntimeResourceLease): AgentRuntimeResourceLease {
	return { ...lease };
}

function cloneResourceBlock(block: AgentRuntimeResourceBlockRecord): AgentRuntimeResourceBlockRecord {
	return {
		...block,
		resources: [...block.resources],
		conflicts: block.conflicts.map(cloneResourceConflict),
	};
}

function cloneSchedulerEvent(event: AgentRuntimeSchedulerEvent): AgentRuntimeSchedulerEvent {
	return {
		...event,
		resourceScopes: [...event.resourceScopes],
		leaseIds: [...event.leaseIds],
		conflicts: event.conflicts.map(cloneResourceConflict),
	};
}

function cloneConflictResolution(record: AgentConflictResolutionRecord): AgentConflictResolutionRecord {
	return {
		...record,
		conflictFiles: [...record.conflictFiles],
		candidateChangedFiles: [...record.candidateChangedFiles],
		inputGateResults: record.inputGateResults.map((gate) => ({ ...gate, args: [...gate.args] })),
		validationGateResults: record.validationGateResults.map((gate) => ({ ...gate, args: [...gate.args] })),
	};
}

function normalizeResourceScopes(resources: readonly string[]): string[] {
	const normalized = resources.map((resource) => resource.trim());
	if (normalized.some((resource) => !resource)) {
		throw new Error("Agent runtime resource scopes must not be empty");
	}
	return [...new Set(normalized)].sort();
}

export class AgentRuntimeScheduler {
	private readonly statePath?: string;
	private readonly now: () => number;
	private readonly tasks = new Map<string, AgentRuntimeTaskRecord>();
	private readonly agents = new Map<string, AgentRuntimeAgentRecord>();
	private readonly integrationRecords = new Map<string, AgentRuntimeIntegrationRecord>();
	private readonly integrationWorkspaces = new Map<string, AgentIntegrationWorkspace>();
	private readonly resourceLeases = new Map<string, AgentRuntimeResourceLease>();
	private readonly resourceBlocks = new Map<string, AgentRuntimeResourceBlockRecord>();
	private readonly conflictResolutions = new Map<string, AgentConflictResolutionRecord>();
	private readonly eventListeners = new Set<AgentRuntimeSchedulerEventListener>();
	private readonly worktreeManager: AgentGitWorktreeManager;
	private readonly mergeManager: AgentMergeManager;
	private readonly conflictResolverManager: AgentConflictResolverManager;
	private readonly integrationQualityGates: AgentIntegrationQualityGate[];
	private readonly resourceLeaseTtlMs: number;
	private readonly conflictResolutionMaxAttempts: number;
	private readonly conflictResolutionTimeoutMs: number;
	private conflictResolver?: AgentConflictResolverRunner;
	private readonly integrationOperations = new Map<string, Promise<AgentRuntimeIntegrationRecord>>();
	private integrationTail: Promise<void> = Promise.resolve();
	private state: AgentRuntimeSchedulerSnapshot;

	constructor(options: CreateAgentRuntimeSchedulerOptions) {
		if (!options.runId.trim()) throw new Error("Agent runtime scheduler runId must not be empty");
		this.statePath = options.statePath;
		this.now = options.now ?? Date.now;
		this.resourceLeaseTtlMs = options.resourceLeaseTtlMs ?? DEFAULT_RESOURCE_LEASE_TTL_MS;
		if (!Number.isFinite(this.resourceLeaseTtlMs) || this.resourceLeaseTtlMs <= 0) {
			throw new Error("Agent runtime resourceLeaseTtlMs must be a positive finite number");
		}
		this.conflictResolutionMaxAttempts =
			options.conflictResolutionMaxAttempts ?? DEFAULT_CONFLICT_RESOLUTION_MAX_ATTEMPTS;
		if (!Number.isInteger(this.conflictResolutionMaxAttempts) || this.conflictResolutionMaxAttempts < 1) {
			throw new Error("Agent runtime conflictResolutionMaxAttempts must be a positive integer");
		}
		this.conflictResolutionTimeoutMs = options.conflictResolutionTimeoutMs ?? DEFAULT_CONFLICT_RESOLUTION_TIMEOUT_MS;
		if (!Number.isInteger(this.conflictResolutionTimeoutMs) || this.conflictResolutionTimeoutMs <= 0) {
			throw new Error("Agent runtime conflictResolutionTimeoutMs must be a positive integer");
		}
		this.conflictResolver = options.conflictResolver;
		this.worktreeManager = new AgentGitWorktreeManager({
			runId: options.runId,
			preferredRoot: options.statePath ? resolve(dirname(options.statePath), "worktrees") : undefined,
			now: this.now,
		});
		const integrationRoot = options.statePath
			? resolve(dirname(options.statePath), "integration")
			: resolve(
					tmpdir(),
					"prime-agent-integrations",
					createHash("sha256")
						.update(`${canonicalWorkspaceId(options.workspacePath)}\0${options.runId}`)
						.digest("hex")
						.slice(0, 16),
				);
		this.mergeManager = new AgentMergeManager({ runId: options.runId, preferredRoot: integrationRoot });
		const resolutionRoot = options.statePath
			? resolve(dirname(options.statePath), "resolutions")
			: resolve(
					tmpdir(),
					"prime-agent-resolutions",
					createHash("sha256")
						.update(`${canonicalWorkspaceId(options.workspacePath)}\0${options.runId}`)
						.digest("hex")
						.slice(0, 16),
				);
		this.conflictResolverManager = new AgentConflictResolverManager({
			runId: options.runId,
			preferredRoot: resolutionRoot,
		});
		this.integrationQualityGates = (options.integrationQualityGates ?? []).map((gate) => ({
			...gate,
			args: gate.args ? [...gate.args] : undefined,
		}));
		const workspaceId = canonicalWorkspaceId(options.workspacePath);
		const loadedState = this.loadState();
		const loaded = loadedState?.snapshot;
		if (loaded) {
			if (loaded.workspaceId !== workspaceId || loaded.runId !== options.runId) {
				throw new Error("Agent runtime scheduler state does not match the requested workspace and run");
			}
			this.state = loaded;
		} else {
			const timestamp = this.timestamp();
			this.state = {
				version: AGENT_RUNTIME_SCHEDULER_STATE_VERSION,
				workspaceId,
				runId: options.runId,
				createdAt: timestamp,
				updatedAt: timestamp,
				tasks: [],
				agents: [],
				integrationRecords: [],
				integrationWorkspaces: [],
				resourceLeases: [],
				resourceBlocks: [],
				conflictResolutions: [],
				events: [],
				nextEventSequence: 1,
			};
		}
		for (const task of this.state.tasks) this.tasks.set(task.id, task);
		for (const agent of this.state.agents) this.agents.set(agent.id, agent);
		for (const record of this.state.integrationRecords) this.integrationRecords.set(record.taskId, record);
		for (const workspace of this.state.integrationWorkspaces) {
			this.integrationWorkspaces.set(workspace.repositoryId, workspace);
		}
		for (const lease of this.state.resourceLeases) this.resourceLeases.set(lease.id, lease);
		for (const block of this.state.resourceBlocks) this.resourceBlocks.set(block.id, block);
		for (const resolutionRecord of this.state.conflictResolutions) {
			this.conflictResolutions.set(resolutionRecord.id, resolutionRecord);
		}
		const expiredLeases = this.expireStaleResourceLeases();
		if (expiredLeases.length > 0) {
			this.resolveResourceBlocks();
			this.appendEvent({
				type: "resource_expired",
				resourceScopes: expiredLeases.map((lease) => lease.scope),
				leaseIds: expiredLeases.map((lease) => lease.id),
				message: "Recovered expired resource ownership during scheduler restoration",
			});
		}
		const recoveredAgents = this.markInterruptedAgentsRecovering();
		const recoveredIntegrations = this.markInterruptedIntegrationsQueued();
		const recoveredResolutions = this.markInterruptedResolutionsEscalated();
		if (
			loadedState?.migrated ||
			expiredLeases.length > 0 ||
			recoveredAgents ||
			recoveredIntegrations ||
			recoveredResolutions
		) {
			this.persist();
		} else if (!loaded) this.persist();
	}

	get workspaceId(): string {
		return this.state.workspaceId;
	}

	get runId(): string {
		return this.state.runId;
	}

	registerTask(input: RegisterAgentRuntimeTaskInput): AgentRuntimeTaskRecord {
		const id = input.id.trim();
		const objective = input.objective.trim();
		if (!id) throw new Error("Agent runtime task id must not be empty");
		if (!objective) throw new Error("Agent runtime task objective must not be empty");
		if (this.tasks.has(id)) throw new Error(`Duplicate agent runtime task id: ${id}`);
		const dependencies = [...new Set(input.dependencies ?? [])];
		const resources = normalizeResourceScopes(input.resources ?? []);
		if (dependencies.includes(id)) throw new Error(`Agent runtime task ${id} cannot depend on itself`);
		for (const dependency of dependencies) {
			if (!this.tasks.has(dependency)) {
				throw new Error(`Agent runtime task ${id} depends on unknown task ${dependency}`);
			}
		}
		const timestamp = this.timestamp();
		const task: AgentRuntimeTaskRecord = {
			id,
			objective,
			dependencies,
			resources,
			status: input.status ?? "planned",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		this.tasks.set(id, task);
		this.persist();
		this.publishEvent({ type: "task_registered", taskId: task.id, status: task.status });
		return cloneTask(task);
	}

	transitionTask(taskId: string, status: AgentRuntimeTaskStatus, error?: string): AgentRuntimeTaskRecord {
		const task = this.requireTask(taskId);
		if (task.status === status) return cloneTask(task);
		const previousStatus = task.status;
		if (!TASK_TRANSITIONS[task.status].has(status)) {
			throw new Error(`Illegal agent runtime task transition: ${task.status} -> ${status}`);
		}
		task.status = status;
		task.updatedAt = this.timestamp();
		task.error = error?.trim() || undefined;
		this.persist();
		this.publishEvent({
			type: this.taskTransitionEventType(previousStatus, status),
			taskId,
			previousStatus,
			status,
			message: task.error,
		});
		return cloneTask(task);
	}

	registerAgent(input: RegisterAgentRuntimeAgentInput): AgentRuntimeAgentRecord {
		const id = input.id.trim();
		if (!id) throw new Error("Agent runtime agent id must not be empty");
		if (this.agents.has(id)) throw new Error(`Duplicate agent runtime agent id: ${id}`);
		this.requireTask(input.taskId);
		const timestamp = this.timestamp();
		const agent: AgentRuntimeAgentRecord = {
			id,
			taskId: input.taskId,
			parentAgentId: input.parentAgentId,
			sessionId: input.sessionId,
			sessionName: input.sessionName,
			status: "admitted",
			createdAt: timestamp,
			updatedAt: timestamp,
			heartbeatAt: timestamp,
		};
		this.agents.set(id, agent);
		this.persist();
		this.publishEvent({ type: "agent_admitted", taskId: agent.taskId, agentId: agent.id, status: agent.status });
		return cloneAgent(agent);
	}

	markAgentRunning(agentId: string, sessionId?: string): AgentRuntimeAgentRecord {
		const agent = this.requireAgent(agentId);
		const previousStatus = agent.status;
		this.transitionAgent(agent, "running");
		if (sessionId) agent.sessionId = sessionId;
		agent.heartbeatAt = agent.updatedAt;
		this.persist();
		this.publishEvent({
			type: "agent_started",
			taskId: agent.taskId,
			agentId: agent.id,
			previousStatus,
			status: agent.status,
		});
		return cloneAgent(agent);
	}

	recordAgentHeartbeat(agentId: string): AgentRuntimeAgentRecord {
		const agent = this.requireAgent(agentId);
		if (!ACTIVE_AGENT_STATUSES.has(agent.status)) {
			return cloneAgent(agent);
		}
		if (agent.status !== "running") this.transitionAgent(agent, "running");
		else agent.updatedAt = this.timestamp();
		agent.heartbeatAt = agent.updatedAt;
		this.renewAgentResourceLeases(agent.id, agent.heartbeatAt);
		this.persist();
		const lastHeartbeatEvent = [...this.state.events]
			.reverse()
			.find((event) => event.type === "agent_heartbeat" && event.agentId === agent.id);
		if (
			!lastHeartbeatEvent ||
			this.now() - Date.parse(lastHeartbeatEvent.occurredAt) >= HEARTBEAT_EVENT_INTERVAL_MS
		) {
			this.publishEvent({ type: "agent_heartbeat", taskId: agent.taskId, agentId: agent.id, status: agent.status });
		}
		return cloneAgent(agent);
	}

	async prepareAgentWorkspace(
		agentId: string,
		input: { sourceCwd: string; metadataDir: string },
	): Promise<AgentGitWorkspace | undefined> {
		const agent = this.requireAgent(agentId);
		const task = this.requireTask(agent.taskId);
		const workspace = await this.worktreeManager.provision({
			sourceCwd: input.sourceCwd,
			taskId: task.id,
			agentId: agent.id,
			objective: task.objective,
			metadataDir: input.metadataDir,
		});
		if (!workspace) return undefined;
		agent.repositoryId = workspace.repositoryId;
		agent.repositoryRoot = workspace.repositoryRoot;
		agent.gitCommonDir = workspace.gitCommonDir;
		agent.baseSha = workspace.baseSha;
		agent.branch = workspace.branch;
		agent.worktreePath = workspace.worktreePath;
		agent.taskContractPath = workspace.taskContractPath;
		agent.resultManifestPath = workspace.resultManifestPath;
		agent.updatedAt = this.timestamp();
		try {
			this.persist();
		} catch (error) {
			await this.worktreeManager.rollbackProvision(workspace).catch(() => undefined);
			delete agent.repositoryId;
			delete agent.repositoryRoot;
			delete agent.gitCommonDir;
			delete agent.baseSha;
			delete agent.branch;
			delete agent.worktreePath;
			delete agent.taskContractPath;
			delete agent.resultManifestPath;
			throw error;
		}
		return workspace;
	}

	async finalizeAgentWorkspace(
		agentId: string,
		finalSummary: string,
	): Promise<AgentRuntimeResultManifest | undefined> {
		const agent = this.requireAgent(agentId);
		const workspace = this.workspaceForAgent(agent);
		if (!workspace) return undefined;
		const manifest = await this.worktreeManager.finalize({
			workspace,
			runId: this.runId,
			taskId: agent.taskId,
			agentId: agent.id,
			finalSummary,
		});
		agent.candidateSha = manifest.resultSha;
		agent.resultManifestPath = workspace.resultManifestPath;
		agent.updatedAt = this.timestamp();
		this.persist();
		return manifest;
	}

	async cleanupAgentWorkspace(agentId: string): Promise<void> {
		const agent = this.requireAgent(agentId);
		const task = this.requireTask(agent.taskId);
		if (task.status !== "integrated" && task.status !== "cancelled") {
			throw new Error(`Cannot clean worktree for task ${task.id} while task status is ${task.status}`);
		}
		const workspace = this.workspaceForAgent(agent);
		if (!workspace || agent.worktreeCleanedAt) return;
		await this.worktreeManager.cleanup(workspace);
		agent.worktreeCleanedAt = this.timestamp();
		agent.updatedAt = agent.worktreeCleanedAt;
		this.persist();
	}

	acquireTaskResources(agentId: string): AgentRuntimeResourceAcquisitionResult {
		this.recoverStaleResourceLeases();
		const agent = this.requireAgent(agentId);
		const task = this.requireTask(agent.taskId);
		const existingLeases = [...this.resourceLeases.values()].filter(
			(lease) => lease.agentId === agent.id && lease.status === "active",
		);
		const existingScopes = new Set(existingLeases.map((lease) => lease.scope));
		const missingResources = task.resources.filter((scope) => !existingScopes.has(scope));
		const conflicts = this.resourceConflicts(missingResources, agent.id);
		if (conflicts.length > 0) {
			const block: AgentRuntimeResourceBlockRecord = {
				id: randomUUID(),
				taskId: task.id,
				agentId: agent.id,
				resources: [...task.resources],
				conflicts,
				detectedAt: this.timestamp(),
			};
			this.resourceBlocks.set(block.id, block);
			this.persist();
			this.publishEvent({
				type: "resource_blocked",
				taskId: task.id,
				agentId: agent.id,
				resourceScopes: task.resources,
				conflicts,
				message: this.formatResourceConflictMessage(conflicts),
			});
			return { acquired: false, leases: [], conflicts: conflicts.map(cloneResourceConflict) };
		}
		const acquiredAt = this.timestamp();
		const expiresAt = new Date(this.now() + this.resourceLeaseTtlMs).toISOString();
		const leases = missingResources.map((scope) => {
			const epoch =
				Math.max(
					0,
					...[...this.resourceLeases.values()]
						.filter((lease) => lease.scope === scope)
						.map((lease) => lease.epoch),
				) + 1;
			const lease: AgentRuntimeResourceLease = {
				id: randomUUID(),
				scope,
				mode: "exclusive",
				taskId: task.id,
				agentId: agent.id,
				epoch,
				status: "active",
				acquiredAt,
				heartbeatAt: acquiredAt,
				expiresAt,
			};
			this.resourceLeases.set(lease.id, lease);
			return lease;
		});
		if (leases.length > 0) {
			this.resolveResourceBlocks();
			this.persist();
			this.publishEvent({
				type: "resource_acquired",
				taskId: task.id,
				agentId: agent.id,
				resourceScopes: leases.map((lease) => lease.scope),
				leaseIds: leases.map((lease) => lease.id),
			});
		}
		return {
			acquired: true,
			leases: [...existingLeases, ...leases].map(cloneResourceLease).sort((a, b) => a.scope.localeCompare(b.scope)),
			conflicts: [],
		};
	}

	releaseAgentResources(
		agentId: string,
		reason: AgentRuntimeResourceReleaseReason = "explicit",
	): AgentRuntimeResourceLease[] {
		this.requireAgent(agentId);
		const releasedAt = this.timestamp();
		const released: AgentRuntimeResourceLease[] = [];
		for (const lease of this.resourceLeases.values()) {
			if (lease.agentId !== agentId || lease.status !== "active") continue;
			lease.status = "released";
			lease.releasedAt = releasedAt;
			lease.releaseReason = reason;
			released.push(lease);
		}
		if (released.length === 0) return [];
		this.resolveResourceBlocks();
		this.persist();
		this.publishEvent({
			type: "resource_released",
			taskId: released[0].taskId,
			agentId,
			resourceScopes: released.map((lease) => lease.scope),
			leaseIds: released.map((lease) => lease.id),
			message: reason,
		});
		return released.map(cloneResourceLease);
	}

	recoverStaleResourceLeases(): AgentRuntimeResourceLease[] {
		const expired = this.expireStaleResourceLeases();
		if (expired.length === 0) return [];
		this.resolveResourceBlocks();
		this.persist();
		this.publishEvent({
			type: "resource_expired",
			taskId: expired.length === 1 ? expired[0].taskId : undefined,
			agentId: expired.length === 1 ? expired[0].agentId : undefined,
			resourceScopes: expired.map((lease) => lease.scope),
			leaseIds: expired.map((lease) => lease.id),
			message: "Recovered expired resource ownership",
		});
		return expired.map(cloneResourceLease);
	}

	getTaskResourceSummary(taskId: string): AgentRuntimeTaskResourceSummary {
		const task = this.requireTask(taskId);
		return {
			taskId,
			resources: [...task.resources],
			ownedResources: [...this.resourceLeases.values()]
				.filter((lease) => lease.taskId === taskId && lease.status === "active")
				.map((lease) => lease.scope)
				.sort(),
		};
	}

	subscribe(listener: AgentRuntimeSchedulerEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	eventsSince(sequence = 0): AgentRuntimeSchedulerEvent[] {
		return this.state.events.filter((event) => event.sequence > sequence).map(cloneSchedulerEvent);
	}

	setConflictResolver(runner: AgentConflictResolverRunner | undefined): void {
		this.conflictResolver = runner;
	}

	hasConflictResolver(): boolean {
		return this.conflictResolver !== undefined;
	}

	clearConflictResolver(runner: AgentConflictResolverRunner): void {
		if (this.conflictResolver === runner) this.conflictResolver = undefined;
	}

	getConflictResolution(resolutionId: string): AgentConflictResolutionRecord | undefined {
		const record = this.conflictResolutions.get(resolutionId);
		return record ? cloneConflictResolution(record) : undefined;
	}

	async integrateAgentWorkspace(agentId: string): Promise<AgentRuntimeIntegrationRecord | undefined> {
		const agent = this.requireAgent(agentId);
		const workspace = this.workspaceForAgent(agent);
		if (!workspace || !agent.candidateSha) return undefined;
		const existing = this.integrationRecords.get(agent.taskId);
		if (existing && (existing.status === "integrated" || existing.status === "failed")) {
			return cloneIntegrationRecord(existing);
		}
		if (existing?.status === "conflict" && !this.canAttemptConflictResolution(existing.taskId)) {
			return cloneIntegrationRecord(existing);
		}
		const activeOperation = this.integrationOperations.get(agent.taskId);
		if (activeOperation) return cloneIntegrationRecord(await activeOperation);
		if (!existing) {
			const record: AgentRuntimeIntegrationRecord = {
				taskId: agent.taskId,
				agentId: agent.id,
				repositoryId: workspace.repositoryId,
				baseSha: workspace.baseSha,
				candidateSha: agent.candidateSha,
				status: "queued",
				queuedAt: this.timestamp(),
				changedFiles: [],
				conflictFiles: [],
				gateResults: [],
			};
			this.integrationRecords.set(record.taskId, record);
			this.persist();
			this.publishEvent({ type: "integration_queued", taskId: record.taskId, agentId: record.agentId });
		}
		const operation = this.integrationTail.then(() => this.performIntegration(agent.id));
		this.integrationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		this.integrationOperations.set(agent.taskId, operation);
		try {
			return cloneIntegrationRecord(await operation);
		} finally {
			this.integrationOperations.delete(agent.taskId);
		}
	}

	async resumePendingIntegrations(): Promise<AgentRuntimeIntegrationRecord[]> {
		const pending = [...this.integrationRecords.values()]
			.filter(
				(record) =>
					record.status === "queued" ||
					record.status === "integrating" ||
					(record.status === "conflict" && this.canAttemptConflictResolution(record.taskId)),
			)
			.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.taskId.localeCompare(b.taskId));
		const results: AgentRuntimeIntegrationRecord[] = [];
		for (const record of pending) {
			const result = await this.integrateAgentWorkspace(record.agentId);
			if (result) results.push(result);
		}
		return results;
	}

	completeAgent(agentId: string): AgentRuntimeAgentRecord {
		return this.finishAgent(agentId, "completed");
	}

	failAgent(agentId: string, error: string): AgentRuntimeAgentRecord {
		return this.finishAgent(agentId, "failed", error);
	}

	cancelAgent(agentId: string, reason?: string): AgentRuntimeAgentRecord {
		return this.finishAgent(agentId, "cancelled", reason);
	}

	markStaleAgentsRecovering(staleAfterMs: number): string[] {
		if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
			throw new Error("staleAfterMs must be a non-negative finite number");
		}
		const cutoff = this.now() - staleAfterMs;
		const recovering: string[] = [];
		for (const agent of this.agents.values()) {
			if (agent.status !== "running") continue;
			const heartbeat = Date.parse(agent.heartbeatAt ?? agent.updatedAt);
			if (Number.isFinite(heartbeat) && heartbeat > cutoff) continue;
			this.transitionAgent(agent, "recovering");
			recovering.push(agent.id);
		}
		if (recovering.length > 0) this.persist();
		return recovering;
	}

	getTaskReadiness(taskId: string): AgentRuntimeTaskReadiness {
		const task = this.requireTask(taskId);
		const blockedBy = task.dependencies.filter((dependency) => this.requireTask(dependency).status !== "integrated");
		return {
			taskId,
			ready: READY_TASK_STATUSES.has(task.status) && blockedBy.length === 0,
			blockedBy,
		};
	}

	getTask(taskId: string): AgentRuntimeTaskRecord | undefined {
		const task = this.tasks.get(taskId);
		return task ? cloneTask(task) : undefined;
	}

	getAgent(agentId: string): AgentRuntimeAgentRecord | undefined {
		const agent = this.agents.get(agentId);
		return agent ? cloneAgent(agent) : undefined;
	}

	getIntegrationRecord(taskId: string): AgentRuntimeIntegrationRecord | undefined {
		const record = this.integrationRecords.get(taskId);
		return record ? cloneIntegrationRecord(record) : undefined;
	}

	private async performIntegration(agentId: string): Promise<AgentRuntimeIntegrationRecord> {
		const agent = this.requireAgent(agentId);
		const task = this.requireTask(agent.taskId);
		const workspace = this.workspaceForAgent(agent);
		const record = this.integrationRecords.get(agent.taskId);
		if (!workspace || !agent.candidateSha || !record) {
			throw new Error(`Agent ${agentId} has no integration candidate`);
		}

		record.status = "integrating";
		record.startedAt ??= this.timestamp();
		record.completedAt = undefined;
		record.error = undefined;
		record.changedFiles = [];
		record.conflictFiles = [];
		record.gateResults = [];
		if (task.status === "completed" || task.status === "conflict") {
			this.transitionTask(task.id, "integrating");
		} else if (task.status === "integrating") {
			this.persist();
		} else {
			throw new Error(`Agent runtime task ${task.id} is not ready for integration: ${task.status}`);
		}

		try {
			const result = await this.mergeManager.integrate({
				taskId: task.id,
				candidateSha: agent.candidateSha,
				candidateWorkspace: workspace,
				integrationWorkspace: this.integrationWorkspaces.get(workspace.repositoryId),
				recoverySha: record.recoverySha,
				qualityGates: this.integrationQualityGates,
				onPrepared: (integrationWorkspace, recoverySha) => {
					this.integrationWorkspaces.set(integrationWorkspace.repositoryId, { ...integrationWorkspace });
					record.recoverySha = recoverySha;
					this.persist();
				},
			});
			this.integrationWorkspaces.set(result.integrationWorkspace.repositoryId, { ...result.integrationWorkspace });
			record.recoverySha = result.recoverySha;
			record.resultSha = result.resultSha;
			record.attemptedSha = result.attemptedSha;
			record.changedFiles = [...result.changedFiles];
			record.conflictFiles = [...result.conflictFiles];
			record.gateResults = result.gateResults.map((gate) => ({ ...gate, args: [...gate.args] }));
			record.error = result.error;
			const resolutionTrigger = this.conflictResolutionTrigger(result.outcome, result.gateResults);
			if (resolutionTrigger && this.conflictResolver) {
				record.status = "conflict";
				record.completedAt = this.timestamp();
				this.transitionTask(task.id, "conflict", result.error);
				await this.performConflictResolution(record, agent, workspace, resolutionTrigger);
				return cloneIntegrationRecord(record);
			}
			record.status = result.outcome;
			record.completedAt = this.timestamp();
			this.transitionTask(task.id, result.outcome, result.error);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record.status = "failed";
			record.completedAt = this.timestamp();
			record.error = message;
			if (task.status === "integrating" || task.status === "completed" || task.status === "conflict") {
				this.transitionTask(task.id, "failed", message);
			} else {
				this.persist();
			}
		}
		return cloneIntegrationRecord(record);
	}

	private async performConflictResolution(
		integrationRecord: AgentRuntimeIntegrationRecord,
		agent: AgentRuntimeAgentRecord,
		candidateWorkspace: AgentGitWorkspace,
		trigger: AgentConflictResolutionTrigger,
	): Promise<void> {
		const runner = this.conflictResolver;
		const recoverySha = integrationRecord.recoverySha;
		const integrationWorkspace = this.integrationWorkspaces.get(candidateWorkspace.repositoryId);
		if (!runner || !recoverySha || !integrationWorkspace) return;

		let attempt = this.conflictResolutionAttempts(integrationRecord.taskId).length + 1;
		while (attempt <= this.conflictResolutionMaxAttempts) {
			const resolution: AgentConflictResolutionRecord = {
				id: randomUUID(),
				taskId: integrationRecord.taskId,
				agentId: agent.id,
				repositoryId: candidateWorkspace.repositoryId,
				trigger,
				status: "queued",
				attempt,
				maxAttempts: this.conflictResolutionMaxAttempts,
				timeoutMs: this.conflictResolutionTimeoutMs,
				candidateSha: integrationRecord.candidateSha,
				recoverySha,
				attemptedSha: integrationRecord.attemptedSha,
				conflictFiles: [...integrationRecord.conflictFiles],
				candidateChangedFiles: [],
				inputGateResults: integrationRecord.gateResults.map((gate) => ({ ...gate, args: [...gate.args] })),
				validationGateResults: [],
				createdAt: this.timestamp(),
			};
			this.conflictResolutions.set(resolution.id, resolution);
			this.persist();
			this.publishEvent({
				type: "resolution_queued",
				resolutionId: resolution.id,
				taskId: resolution.taskId,
				agentId: resolution.agentId,
				message: `Conflict resolution attempt ${attempt}/${this.conflictResolutionMaxAttempts} queued`,
			});

			try {
				const execution = await this.conflictResolverManager.execute({
					resolutionId: resolution.id,
					taskId: resolution.taskId,
					trigger,
					attempt,
					maxAttempts: this.conflictResolutionMaxAttempts,
					timeoutMs: this.conflictResolutionTimeoutMs,
					candidateSha: integrationRecord.candidateSha,
					recoverySha,
					attemptedSha: integrationRecord.attemptedSha,
					conflictFiles: integrationRecord.conflictFiles,
					inputGateResults: integrationRecord.gateResults,
					taskContracts: this.taskContractsForResolution(candidateWorkspace.repositoryId, resolution.taskId),
					candidateWorkspace,
					runner,
					onPrepared: (workspace, candidateChangedFiles) => {
						resolution.status = "running";
						resolution.startedAt = this.timestamp();
						resolution.branch = workspace.branch;
						resolution.worktreePath = workspace.worktreePath;
						resolution.contextPath = workspace.contextPath;
						resolution.candidateChangedFiles = [...candidateChangedFiles];
						this.persist();
						this.publishEvent({
							type: "resolution_started",
							resolutionId: resolution.id,
							taskId: resolution.taskId,
							agentId: resolution.agentId,
							message: `Conflict resolver started in ${workspace.worktreePath}`,
						});
					},
				});
				resolution.resolverSessionId = execution.resolverSessionId;
				resolution.summary = execution.summary?.trim() || undefined;
				resolution.candidateChangedFiles = [...execution.candidateChangedFiles];
				resolution.completedAt = this.timestamp();
				if (execution.outcome !== "candidate" || !execution.resolutionSha) {
					resolution.status = execution.outcome === "timed_out" ? "timed_out" : "failed";
					resolution.error = execution.error ?? "Conflict resolver did not produce a candidate";
					if (this.finishResolutionAttempt(resolution)) return;
					attempt += 1;
					continue;
				}

				resolution.resolutionSha = execution.resolutionSha;
				const promotion = await this.mergeManager.integrateResolution({
					taskId: resolution.taskId,
					candidateSha: integrationRecord.candidateSha,
					resolutionSha: execution.resolutionSha,
					recoverySha,
					candidateWorkspace,
					integrationWorkspace,
					qualityGates: this.integrationQualityGates,
				});
				resolution.validationGateResults = promotion.gateResults.map((gate) => ({
					...gate,
					args: [...gate.args],
				}));
				if (promotion.outcome !== "integrated" || !promotion.resultSha) {
					resolution.status = "failed";
					resolution.error = promotion.error ?? "Conflict resolution validation failed";
					if (this.finishResolutionAttempt(resolution)) return;
					attempt += 1;
					continue;
				}

				resolution.status = "resolved";
				resolution.completedAt = this.timestamp();
				this.integrationWorkspaces.set(promotion.integrationWorkspace.repositoryId, {
					...promotion.integrationWorkspace,
				});
				integrationRecord.status = "integrating";
				integrationRecord.completedAt = undefined;
				this.transitionTask(resolution.taskId, "integrating");
				integrationRecord.status = "integrated";
				integrationRecord.completedAt = resolution.completedAt;
				integrationRecord.resultSha = promotion.resultSha;
				integrationRecord.attemptedSha = execution.resolutionSha;
				integrationRecord.changedFiles = [...promotion.changedFiles];
				integrationRecord.gateResults = promotion.gateResults.map((gate) => ({ ...gate, args: [...gate.args] }));
				integrationRecord.error = undefined;
				this.transitionTask(resolution.taskId, "integrated");
				try {
					await this.conflictResolverManager.cleanupSuccessful(execution.workspace);
					resolution.workspaceCleanedAt = this.timestamp();
				} catch {
					// The integrated commit is authoritative; retained resolver evidence remains safe to inspect.
				}
				this.persist();
				this.publishEvent({
					type: "resolution_succeeded",
					resolutionId: resolution.id,
					taskId: resolution.taskId,
					agentId: resolution.agentId,
					message: `Conflict resolution attempt ${attempt} passed all integration gates`,
				});
				return;
			} catch (error) {
				resolution.status = "failed";
				resolution.completedAt = this.timestamp();
				resolution.error = error instanceof Error ? error.message : String(error);
				if (this.finishResolutionAttempt(resolution)) return;
				attempt += 1;
			}
		}
	}

	private finishResolutionAttempt(resolution: AgentConflictResolutionRecord): boolean {
		const exhausted = resolution.attempt >= resolution.maxAttempts;
		if (exhausted) {
			resolution.status = "escalated";
			this.persist();
			this.publishEvent({
				type: "resolution_escalated",
				resolutionId: resolution.id,
				taskId: resolution.taskId,
				agentId: resolution.agentId,
				message:
					`Conflict resolution exhausted ${resolution.maxAttempts} attempts; user direction is required. ${resolution.error ?? ""}`.trim(),
			});
			return true;
		}
		this.persist();
		this.publishEvent({
			type: "resolution_retrying",
			resolutionId: resolution.id,
			taskId: resolution.taskId,
			agentId: resolution.agentId,
			message:
				`Conflict resolution attempt ${resolution.attempt} failed; retrying. ${resolution.error ?? ""}`.trim(),
		});
		return false;
	}

	private conflictResolutionTrigger(
		outcome: AgentMergeOutcome,
		gateResults: readonly AgentIntegrationGateResult[],
	): AgentConflictResolutionTrigger | undefined {
		if (outcome === "conflict") return "git_conflict";
		if (outcome === "failed" && gateResults.some((gate) => !gate.passed)) return "quality_gate_failure";
		return undefined;
	}

	private conflictResolutionAttempts(taskId: string): AgentConflictResolutionRecord[] {
		return [...this.conflictResolutions.values()]
			.filter((record) => record.taskId === taskId)
			.sort((a, b) => a.attempt - b.attempt || a.createdAt.localeCompare(b.createdAt));
	}

	private canAttemptConflictResolution(taskId: string): boolean {
		const attempts = this.conflictResolutionAttempts(taskId);
		return Boolean(
			this.conflictResolver &&
				attempts.length < this.conflictResolutionMaxAttempts &&
				attempts.at(-1)?.status !== "escalated",
		);
	}

	private taskContractsForResolution(repositoryId: string, candidateTaskId: string): AgentRuntimeTaskContract[] {
		const contracts: AgentRuntimeTaskContract[] = [];
		for (const agent of this.agents.values()) {
			if (agent.repositoryId !== repositoryId || !agent.taskContractPath || !existsSync(agent.taskContractPath)) {
				continue;
			}
			const integration = this.integrationRecords.get(agent.taskId);
			if (agent.taskId !== candidateTaskId && integration?.status !== "integrated") continue;
			try {
				const contract = parseAgentRuntimeTaskContract(
					JSON.parse(readFileSync(agent.taskContractPath, "utf8")) as unknown,
				);
				if (
					contract.runId === this.runId &&
					contract.repositoryId === repositoryId &&
					contract.taskId === agent.taskId &&
					contract.agentId === agent.id &&
					contract.baseSha === agent.baseSha &&
					contract.branch === agent.branch &&
					agent.repositoryRoot !== undefined &&
					agent.worktreePath !== undefined &&
					canonicalWorkspaceId(contract.repositoryRoot) === canonicalWorkspaceId(agent.repositoryRoot) &&
					canonicalWorkspaceId(contract.worktreePath) === canonicalWorkspaceId(agent.worktreePath)
				) {
					contracts.push(contract);
				}
			} catch {
				// Invalid contracts are excluded; the persisted resolution record still retains candidate evidence.
			}
		}
		return contracts.sort((a, b) => {
			if (a.taskId === candidateTaskId) return -1;
			if (b.taskId === candidateTaskId) return 1;
			return a.taskId.localeCompare(b.taskId);
		});
	}

	summary(): AgentRuntimeSchedulerSummary {
		this.recoverStaleResourceLeases();
		const taskCounts: Partial<Record<AgentRuntimeTaskStatus, number>> = {};
		const agentCounts: Partial<Record<AgentRuntimeAgentStatus, number>> = {};
		const readyTaskIds: string[] = [];
		const blockedTaskIds: string[] = [];
		for (const task of this.tasks.values()) {
			taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
			if (!READY_TASK_STATUSES.has(task.status)) continue;
			const readiness = this.getTaskReadiness(task.id);
			if (readiness.ready) readyTaskIds.push(task.id);
			else blockedTaskIds.push(task.id);
		}
		const activeAgents: AgentRuntimeAgentRecord[] = [];
		const workspaceAgents: AgentRuntimeAgentRecord[] = [];
		for (const agent of this.agents.values()) {
			agentCounts[agent.status] = (agentCounts[agent.status] ?? 0) + 1;
			if (ACTIVE_AGENT_STATUSES.has(agent.status)) activeAgents.push(cloneAgent(agent));
			if (agent.worktreePath) workspaceAgents.push(cloneAgent(agent));
		}
		return {
			workspaceId: this.state.workspaceId,
			runId: this.state.runId,
			updatedAt: this.state.updatedAt,
			taskCounts,
			agentCounts,
			readyTaskIds: readyTaskIds.sort(),
			blockedTaskIds: blockedTaskIds.sort(),
			activeAgents: activeAgents.sort((a, b) => a.id.localeCompare(b.id)),
			workspaceAgents: workspaceAgents.sort((a, b) => a.id.localeCompare(b.id)),
			integrationRecords: [...this.integrationRecords.values()]
				.map(cloneIntegrationRecord)
				.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.taskId.localeCompare(b.taskId)),
			integrationWorkspaces: [...this.integrationWorkspaces.values()]
				.map((workspace) => ({ ...workspace }))
				.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId)),
			activeResourceLeases: [...this.resourceLeases.values()]
				.filter((lease) => lease.status === "active")
				.map(cloneResourceLease)
				.sort((a, b) => a.scope.localeCompare(b.scope) || a.epoch - b.epoch),
			blockedResourceTasks: [...this.resourceBlocks.values()]
				.filter((block) => !block.resolvedAt)
				.map(cloneResourceBlock)
				.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.taskId.localeCompare(b.taskId)),
			taskResources: [...this.tasks.values()]
				.filter((task) => task.resources.length > 0)
				.map((task) => this.getTaskResourceSummary(task.id))
				.sort((a, b) => a.taskId.localeCompare(b.taskId)),
			conflictResolutions: [...this.conflictResolutions.values()]
				.map(cloneConflictResolution)
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.attempt - b.attempt),
			recentEvents: this.state.events.slice(-MAX_SUMMARY_SCHEDULER_EVENTS).map(cloneSchedulerEvent),
			latestEventSequence: this.state.nextEventSequence - 1,
		};
	}

	snapshot(): AgentRuntimeSchedulerSnapshot {
		return {
			...this.state,
			tasks: [...this.tasks.values()].map(cloneTask),
			agents: [...this.agents.values()].map(cloneAgent),
			integrationRecords: [...this.integrationRecords.values()].map(cloneIntegrationRecord),
			integrationWorkspaces: [...this.integrationWorkspaces.values()].map((workspace) => ({ ...workspace })),
			resourceLeases: [...this.resourceLeases.values()].map(cloneResourceLease),
			resourceBlocks: [...this.resourceBlocks.values()].map(cloneResourceBlock),
			conflictResolutions: [...this.conflictResolutions.values()].map(cloneConflictResolution),
			events: this.state.events.map(cloneSchedulerEvent),
		};
	}

	private finishAgent(
		agentId: string,
		status: "completed" | "failed" | "cancelled",
		error?: string,
	): AgentRuntimeAgentRecord {
		const agent = this.requireAgent(agentId);
		if (agent.status === status) return cloneAgent(agent);
		const previousStatus = agent.status;
		this.transitionAgent(agent, status);
		agent.error = error?.trim() || undefined;
		this.persist();
		this.releaseAgentResources(agent.id, `agent_${status}` as AgentRuntimeResourceReleaseReason);
		this.publishEvent({
			type: `agent_${status}` as "agent_completed" | "agent_failed" | "agent_cancelled",
			taskId: agent.taskId,
			agentId: agent.id,
			previousStatus,
			status,
			message: agent.error,
		});
		return cloneAgent(agent);
	}

	private transitionAgent(agent: AgentRuntimeAgentRecord, status: AgentRuntimeAgentStatus): void {
		if (agent.status === status) return;
		if (!AGENT_TRANSITIONS[agent.status].has(status)) {
			throw new Error(`Illegal agent runtime agent transition: ${agent.status} -> ${status}`);
		}
		agent.status = status;
		agent.updatedAt = this.timestamp();
	}

	private taskTransitionEventType(
		previousStatus: AgentRuntimeTaskStatus,
		status: AgentRuntimeTaskStatus,
	): AgentRuntimeSchedulerEventType {
		if (status === "integrating") return "integration_started";
		if (status === "integrated") return "integration_completed";
		if (status === "conflict") return "integration_conflicted";
		if (status === "failed" && previousStatus === "integrating") return "integration_failed";
		return "task_status_changed";
	}

	private resourceConflicts(resources: readonly string[], agentId: string): AgentRuntimeResourceConflict[] {
		const requested = new Set(resources);
		return [...this.resourceLeases.values()]
			.filter((lease) => lease.status === "active" && lease.agentId !== agentId && requested.has(lease.scope))
			.map((lease) => ({
				scope: lease.scope,
				leaseId: lease.id,
				ownerTaskId: lease.taskId,
				ownerAgentId: lease.agentId,
				expiresAt: lease.expiresAt,
			}))
			.sort((a, b) => a.scope.localeCompare(b.scope) || a.leaseId.localeCompare(b.leaseId));
	}

	private renewAgentResourceLeases(agentId: string, heartbeatAt: string): void {
		const expiresAt = new Date(this.now() + this.resourceLeaseTtlMs).toISOString();
		for (const lease of this.resourceLeases.values()) {
			if (lease.agentId !== agentId || lease.status !== "active") continue;
			lease.heartbeatAt = heartbeatAt;
			lease.expiresAt = expiresAt;
		}
	}

	private expireStaleResourceLeases(): AgentRuntimeResourceLease[] {
		const now = this.now();
		const expiredAt = new Date(now).toISOString();
		const expired: AgentRuntimeResourceLease[] = [];
		for (const lease of this.resourceLeases.values()) {
			if (lease.status !== "active") continue;
			const owner = this.agents.get(lease.agentId);
			const ownerTerminal = owner && !ACTIVE_AGENT_STATUSES.has(owner.status);
			if (!ownerTerminal && Date.parse(lease.expiresAt) > now) continue;
			lease.status = "expired";
			lease.releasedAt = expiredAt;
			lease.releaseReason = "lease_expired";
			expired.push(lease);
		}
		return expired;
	}

	private resolveResourceBlocks(): void {
		const resolvedAt = this.timestamp();
		for (const block of this.resourceBlocks.values()) {
			if (block.resolvedAt || this.resourceConflicts(block.resources, block.agentId).length > 0) continue;
			block.resolvedAt = resolvedAt;
		}
	}

	private formatResourceConflictMessage(conflicts: readonly AgentRuntimeResourceConflict[]): string {
		return conflicts
			.map((conflict) => `${conflict.scope} is owned by task ${conflict.ownerTaskId} (${conflict.ownerAgentId})`)
			.join("; ");
	}

	private appendEvent(input: AgentRuntimeSchedulerEventInput): AgentRuntimeSchedulerEvent {
		const sequence = this.state.nextEventSequence++;
		const event: AgentRuntimeSchedulerEvent = {
			...input,
			id: `${this.state.runId}:${sequence}`,
			sequence,
			occurredAt: this.timestamp(),
			resourceScopes: [...(input.resourceScopes ?? [])],
			leaseIds: [...(input.leaseIds ?? [])],
			conflicts: (input.conflicts ?? []).map(cloneResourceConflict),
		};
		this.state.events.push(event);
		if (this.state.events.length > MAX_PERSISTED_SCHEDULER_EVENTS) {
			this.state.events.splice(0, this.state.events.length - MAX_PERSISTED_SCHEDULER_EVENTS);
		}
		return event;
	}

	private publishEvent(input: AgentRuntimeSchedulerEventInput): AgentRuntimeSchedulerEvent {
		const event = this.appendEvent(input);
		this.persist();
		for (const listener of this.eventListeners) {
			try {
				const result = listener(cloneSchedulerEvent(event));
				if (result) void result.catch(() => undefined);
			} catch {
				// Scheduler state remains authoritative when a context consumer fails.
			}
		}
		return cloneSchedulerEvent(event);
	}

	private requireTask(taskId: string): AgentRuntimeTaskRecord {
		const task = this.tasks.get(taskId);
		if (!task) throw new Error(`Unknown agent runtime task: ${taskId}`);
		return task;
	}

	private requireAgent(agentId: string): AgentRuntimeAgentRecord {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Unknown agent runtime agent: ${agentId}`);
		return agent;
	}

	private workspaceForAgent(agent: AgentRuntimeAgentRecord): AgentGitWorkspace | undefined {
		if (
			!agent.repositoryId ||
			!agent.repositoryRoot ||
			!agent.gitCommonDir ||
			!agent.baseSha ||
			!agent.branch ||
			!agent.worktreePath ||
			!agent.taskContractPath ||
			!agent.resultManifestPath
		) {
			return undefined;
		}
		return {
			repositoryId: agent.repositoryId,
			repositoryRoot: agent.repositoryRoot,
			gitCommonDir: agent.gitCommonDir,
			baseSha: agent.baseSha,
			branch: agent.branch,
			worktreePath: agent.worktreePath,
			taskContractPath: agent.taskContractPath,
			resultManifestPath: agent.resultManifestPath,
		};
	}

	private markInterruptedAgentsRecovering(): boolean {
		let changed = false;
		for (const agent of this.agents.values()) {
			if (agent.status !== "admitted" && agent.status !== "running") continue;
			this.transitionAgent(agent, "recovering");
			changed = true;
		}
		return changed;
	}

	private markInterruptedIntegrationsQueued(): boolean {
		let changed = false;
		for (const record of this.integrationRecords.values()) {
			if (record.status !== "integrating") continue;
			record.status = "queued";
			record.completedAt = undefined;
			changed = true;
		}
		return changed;
	}

	private markInterruptedResolutionsEscalated(): boolean {
		let changed = false;
		for (const record of this.conflictResolutions.values()) {
			if (record.status !== "queued" && record.status !== "running") continue;
			record.status = "escalated";
			record.completedAt = this.timestamp();
			record.error = "Scheduler restarted while the conflict resolver was active; evidence was preserved";
			this.appendEvent({
				type: "resolution_escalated",
				resolutionId: record.id,
				taskId: record.taskId,
				agentId: record.agentId,
				message: `${record.error}; user direction is required before reusing the interrupted workspace`,
			});
			changed = true;
		}
		return changed;
	}

	private loadState(): { snapshot: AgentRuntimeSchedulerSnapshot; migrated: boolean } | undefined {
		if (!this.statePath || !existsSync(this.statePath)) return undefined;
		const value = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
		return {
			snapshot: parseSnapshot(value),
			migrated:
				isRecord(value) &&
				(value.version === PREVIOUS_AGENT_RUNTIME_SCHEDULER_STATE_VERSION ||
					value.version === LEGACY_AGENT_RUNTIME_SCHEDULER_STATE_VERSION),
		};
	}

	private persist(): void {
		this.state.version = AGENT_RUNTIME_SCHEDULER_STATE_VERSION;
		this.state.tasks = [...this.tasks.values()];
		this.state.agents = [...this.agents.values()];
		this.state.integrationRecords = [...this.integrationRecords.values()];
		this.state.integrationWorkspaces = [...this.integrationWorkspaces.values()];
		this.state.resourceLeases = [...this.resourceLeases.values()];
		this.state.resourceBlocks = [...this.resourceBlocks.values()];
		this.state.conflictResolutions = [...this.conflictResolutions.values()];
		this.state.updatedAt = this.timestamp();
		if (!this.statePath) return;
		mkdirSync(dirname(this.statePath), { recursive: true });
		const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, this.statePath);
	}

	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}
}
