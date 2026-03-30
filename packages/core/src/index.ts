export const VERSION = "0.1.0";

// ─── Orchestrator (public API) ──────────────────────────

export { loadAgentFile } from "@/agents/loader";
export { AgentRegistry } from "@/agents/registry";
export { resolveAgent } from "@/agents/resolver";
export {
  agentConfigSchema,
  agentModelSchema,
  agentSandboxSchema,
  agentToolEntrySchema,
  agentToolSchema,
} from "@/agents/schema";
export type {
  SemaphoreCallbacks,
  SemaphoreConfig,
} from "@/concurrency/semaphore";
// ─── Concurrency ────────────────────────────────────────
export { Semaphore } from "@/concurrency/semaphore";
export type {
  GlobalConfig,
  McpServerConfig,
  NeoConfig,
  RepoConfig,
  RepoConfigInput,
} from "@/config";
export {
  addRepoToGlobalConfig,
  ConfigStore,
  globalConfigSchema,
  listReposFromGlobalConfig,
  loadConfig,
  loadGlobalConfig,
  mcpServerConfigSchema,
  neoConfigSchema,
  removeRepoFromGlobalConfig,
  repoConfigSchema,
  repoOverrideConfigSchema,
} from "@/config";
// ─── Cost ──────────────────────────────────────────────
export { CostJournal } from "@/cost/journal";
// ─── Events ────────────────────────────────────────────
export {
  EventJournal,
  matchesFilter,
  NeoEventEmitter,
  WebhookDispatcher,
} from "@/events";
export type { SessionCloneInfo } from "@/isolation/clone";
// ─── Isolation ──────────────────────────────────────────
export {
  createSessionClone,
  listSessionClones,
  removeSessionClone,
} from "@/isolation/clone";
export {
  createBranch,
  deleteBranch,
  fetchRemote,
  getBranchName,
  getCurrentBranch,
  pushBranch,
  pushSessionBranch,
} from "@/isolation/git";
export type { SandboxConfig } from "@/isolation/sandbox";
export { buildSandboxConfig } from "@/isolation/sandbox";
export type { AuditLogMiddleware } from "@/middleware/audit-log";
// ─── Middleware ─────────────────────────────────────────
export { auditLog } from "@/middleware/audit-log";
export { budgetGuard } from "@/middleware/budget-guard";
export type { MiddlewareChain, SDKHooks } from "@/middleware/chain";
export { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
export type { LoopDetectionMiddleware } from "@/middleware/loop-detection";
export { loopDetection } from "@/middleware/loop-detection";
export type { OrchestratorOptions } from "@/orchestrator";
export { Orchestrator } from "@/orchestrator";
// ─── Paths ─────────────────────────────────────────────
export {
  getDataDir,
  getJournalsDir,
  getRepoRunsDir,
  getRunDispatchPath,
  getRunLogPath,
  getRunsDir,
  getSupervisorActivityPath,
  getSupervisorDecisionsPath,
  getSupervisorDir,
  getSupervisorEventsPath,
  getSupervisorInboxPath,
  getSupervisorLockPath,
  getSupervisorStatePath,
  getSupervisorsDir,
  getWorkerStartedPath,
  toRepoSlug,
} from "@/paths";
export type { ParsedOutput } from "@/runner/output-parser";
// ─── Runner ────────────────────────────────────────────
export { parseOutput } from "@/runner/output-parser";
export type { RecoveryOptions } from "@/runner/recovery";
export { runWithRecovery } from "@/runner/recovery";
export type {
  SessionEvent,
  SessionOptions,
  SessionResult,
} from "@/runner/session";
export { runSession, SessionError } from "@/runner/session";
export type {
  SessionExecutionConfig,
  SessionExecutionDeps,
  SessionExecutionInput,
  SessionExecutionResult,
} from "@/runner/session-executor";
export {
  buildFullPrompt,
  buildGitStrategyInstructions,
  buildReportingInstructions,
  loadRepoInstructions,
  SessionExecutor,
} from "@/runner/session-executor";
// ─── Process utilities ─────────────────────────────────
export { isProcessAlive } from "@/shared/process";
// ─── Supervisor (types) ────────────────────────────────
export type {
  ActivityEntry,
  ActivityQueryOptions,
  AIAdapter,
  AIQueryOptions,
  Decision,
  DecisionInput,
  DecisionOption,
  Directive,
  DirectiveCreateInput,
  DirectiveTrigger,
  HeartbeatLoopOptions,
  InboxMessage,
  LogBufferEntry,
  QueuedEvent,
  SessionHandle,
  SupervisorDaemonOptions,
  SupervisorDaemonState,
  SupervisorMessage,
  SupervisorStatus,
  WebhookIncomingEvent,
} from "@/supervisor/index";
// ─── Supervisor (daemon) ──────────────────────────────
export {
  ActivityLog,
  activityEntrySchema,
  appendLogBuffer,
  ClaudeAdapter,
  DecisionStore,
  DirectiveStore,
  decisionOptionSchema,
  decisionSchema,
  EventQueue,
  HeartbeatLoop,
  inboxMessageSchema,
  JsonlSupervisorStore,
  parseDirectiveDuration,
  readLogBuffer,
  StatusReader,
  SupervisorDaemon,
  supervisorDaemonStateSchema,
  supervisorStatusSchema,
  WebhookServer,
  webhookIncomingEventSchema,
} from "@/supervisor/index";
export type {
  Embedder,
  KnowledgeSubtype,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryType,
  MemoryWriteInput,
} from "@/supervisor/memory/index";
// ─── Memory ───────────────────────────────────────────
export { knowledgeSubtypeSchema, MemoryStore } from "@/supervisor/memory/index";
// ─── Task Store ──────────────────────────────────────
export type {
  TaskCreateInput,
  TaskEntry,
  TaskPriority,
  TaskQuery,
  TaskStatus,
} from "@/supervisor/task-store";
export {
  TaskStore,
  taskEntrySchema,
  taskPrioritySchema,
  taskStatusSchema,
} from "@/supervisor/task-store";
// ─── Types (explicit public exports) ──────────────────────
export type {
  ActiveSession,
  AgentDefinition,
  AgentMessageEvent,
  AgentToolUseEvent,
  BudgetAlertEvent,
  CostEntry,
  CostUpdateEvent,
  DispatchInput,
  GateWaitingEvent,
  HookEvent,
  Middleware,
  MiddlewareContext,
  MiddlewareContextMap,
  MiddlewareEvent,
  MiddlewareHandler,
  MiddlewareResult,
  NeoEvent,
  OrchestratorShutdownEvent,
  OrchestratorStatus,
  PersistedRun,
  Priority,
  QueueDequeueEvent,
  QueueEnqueueEvent,
  ResolvedAgent,
  RunContext,
  SessionCompleteEvent,
  SessionFailEvent,
  SessionStartEvent,
  StepCompleteEvent,
  StepResult,
  StepStartEvent,
  SubagentDefinition,
  TaskResult,
} from "@/types";
// ─── Webhook Config ────────────────────────────────────
export type {
  WebhookEntry,
  WebhookEntryInput,
  WebhookTestPayload,
  WebhookTestResult,
} from "@/webhook-config";
export {
  addWebhook,
  listWebhooks,
  removeWebhook,
  testWebhooks,
  webhookEntrySchema,
} from "@/webhook-config";
