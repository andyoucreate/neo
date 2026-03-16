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
  globalConfigSchema,
  listReposFromGlobalConfig,
  loadConfig,
  loadGlobalConfig,
  mcpServerConfigSchema,
  neoConfigSchema,
  removeRepoFromGlobalConfig,
  repoConfigSchema,
} from "@/config";
// ─── Cost ──────────────────────────────────────────────
export { CostJournal } from "@/cost/journal";
export { NeoEventEmitter } from "@/events";
// ─── Events ────────────────────────────────────────────
export { EventJournal } from "@/events/journal";
export { matchesFilter, WebhookDispatcher } from "@/events/webhook";
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
  getSupervisorDir,
  getSupervisorEventsPath,
  getSupervisorInboxPath,
  getSupervisorLockPath,
  getSupervisorStatePath,
  getSupervisorsDir,
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
export type { SupervisorState } from "@/supervisor";
// ─── Supervisor (legacy) ──────────────────────────────
export { supervisorStateSchema } from "@/supervisor";
export type {
  ActivityEntry,
  HeartbeatLoopOptions,
  InboxMessage,
  QueuedEvent,
  RunNote,
  SupervisorDaemonOptions,
  SupervisorDaemonState,
  WebhookIncomingEvent,
} from "@/supervisor/index";
// ─── Supervisor (daemon) ──────────────────────────────
export {
  ActivityLog,
  activityEntrySchema,
  appendLogBuffer,
  appendRunNote,
  EventQueue,
  findRepoSlugForRun,
  getActiveRunsWithNotes,
  getRecentCompletedRunsWithNotes,
  HeartbeatLoop,
  inboxMessageSchema,
  loadFocus,
  loadKnowledge,
  readRunNotes,
  SupervisorDaemon,
  supervisorDaemonStateSchema,
  WebhookServer,
  webhookIncomingEventSchema,
} from "@/supervisor/index";
export * from "@/types";
// ─── Workflows ─────────────────────────────────────────
export { loadWorkflow, workflowGateDefSchema, workflowStepDefSchema } from "@/workflows/loader";
export { WorkflowRegistry } from "@/workflows/registry";
