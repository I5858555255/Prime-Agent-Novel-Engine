/**
 * Core modules shared between all run modes.
 */

export {
	type AgentConflictResolutionExecutionResult,
	type AgentConflictResolutionRecord,
	type AgentConflictResolutionRequest,
	type AgentConflictResolutionStatus,
	type AgentConflictResolutionTrigger,
	type AgentConflictResolutionWorkspace,
	type AgentConflictResolverContext,
	AgentConflictResolverManager,
	type AgentConflictResolverRunner,
	type AgentConflictResolverRunnerResult,
	type CreateAgentConflictResolverManagerOptions,
} from "./agent-conflict-resolver.js";
export {
	AGENT_RUNTIME_RESULT_MANIFEST_VERSION,
	AGENT_RUNTIME_TASK_CONTRACT_VERSION,
	type AgentGitRepositoryCapability,
	type AgentGitWorkspace,
	AgentGitWorktreeManager,
	type AgentRuntimeResultManifest,
	type AgentRuntimeTaskContract,
	formatAgentRuntimeTaskPrompt,
	parseAgentRuntimeResultManifest,
	parseAgentRuntimeTaskContract,
} from "./agent-git-worktree.js";
export {
	type AgentIntegrationGateResult,
	type AgentIntegrationQualityGate,
	type AgentIntegrationWorkspace,
	AgentMergeManager,
	type AgentMergeOutcome,
	type AgentMergeRequest,
	type AgentMergeResult,
	type AgentResolutionMergeRequest,
	type CreateAgentMergeManagerOptions,
} from "./agent-merge-manager.js";
export {
	AGENT_RUNTIME_SCHEDULER_STATE_VERSION,
	type AgentRuntimeAgentRecord,
	type AgentRuntimeAgentStatus,
	type AgentRuntimeIntegrationRecord,
	type AgentRuntimeIntegrationStatus,
	type AgentRuntimeResourceAcquisitionResult,
	type AgentRuntimeResourceBlockRecord,
	type AgentRuntimeResourceConflict,
	type AgentRuntimeResourceLease,
	type AgentRuntimeResourceLeaseStatus,
	type AgentRuntimeResourceReleaseReason,
	AgentRuntimeScheduler,
	type AgentRuntimeSchedulerEvent,
	type AgentRuntimeSchedulerEventListener,
	type AgentRuntimeSchedulerEventType,
	type AgentRuntimeSchedulerSnapshot,
	type AgentRuntimeSchedulerSummary,
	type AgentRuntimeTaskReadiness,
	type AgentRuntimeTaskRecord,
	type AgentRuntimeTaskResourceSummary,
	type AgentRuntimeTaskStatus,
} from "./agent-runtime-scheduler.js";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
} from "./agent-session.js";
export type { AgentSessionRuntimeConfig } from "./agent-session-config.js";
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeKind,
	type AgentSessionRuntimeMetadata,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.js";
export {
	type AgentSessionCreationOptions,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.js";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.js";
export type { CompactionResult } from "./compaction/index.js";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.js";
// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.js";
export type { RefinementResult } from "./refinement/index.js";
export type { CreateRlmSubagentRuntimeOptions, RlmSubagentRuntime, SubagentRuntimeHost } from "./rlm-runtime.js";
export { SessionImportFileNotFoundError } from "./session-import-errors.js";
export type { SessionStats } from "./session-stats.js";
export { createSyntheticSourceInfo } from "./source-info.js";
