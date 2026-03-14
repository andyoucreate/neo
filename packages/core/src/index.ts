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
// ─── Concurrency ────────────────────────────────────────
export type {
  SemaphoreCallbacks,
  SemaphoreConfig,
} from "@/concurrency/semaphore";
export { Semaphore } from "@/concurrency/semaphore";
export {
  loadConfig,
  mcpServerConfigSchema,
  neoConfigSchema,
  repoConfigSchema,
} from "@/config";
// ─── Cost ──────────────────────────────────────────────
export { CostJournal } from "@/cost/journal";
export { NeoEventEmitter } from "@/events";
// ─── Events ────────────────────────────────────────────
export { EventJournal } from "@/events/journal";
export {
  createBranch,
  deleteBranch,
  fetchRemote,
  getBranchName,
  getCurrentBranch,
  pushBranch,
} from "@/isolation/git";
// ─── Isolation ──────────────────────────────────────────
export { withGitLock } from "@/isolation/git-mutex";
export type { SandboxConfig } from "@/isolation/sandbox";
export { buildSandboxConfig } from "@/isolation/sandbox";
export type { WorktreeInfo } from "@/isolation/worktree";
export {
  cleanupOrphanedWorktrees,
  createWorktree,
  listWorktrees,
  removeWorktree,
} from "@/isolation/worktree";
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
export * from "@/types";
// ─── Workflows ─────────────────────────────────────────
export { loadWorkflow, workflowGateDefSchema, workflowStepDefSchema } from "@/workflows/loader";
export { WorkflowRegistry } from "@/workflows/registry";
