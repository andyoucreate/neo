// ─── Components ──────────────────────────────────────────
export { ActivityLog } from "./activity-log.js";
// ─── AI Adapter ───────────────────────────────────────
export { ClaudeAdapter } from "./adapters/claude.js";
export type { AIAdapter, AIQueryOptions, SessionHandle, SupervisorMessage } from "./ai-adapter.js";
// ─── Child command parser (add spawn export) ────────────
export type { ChildSpawnCommand } from "./child-command-parser.js";
export { parseChildSpawnCommand } from "./child-command-parser.js";
// ─── Child spawner ──────────────────────────────────────
export type { SpawnChildOptions, SpawnChildResult } from "./child-spawner.js";
export { spawnChildSupervisor } from "./child-spawner.js";
// ─── Children file ─────────────────────────────────────
export { readChildrenFile, writeChildrenFile } from "./children-file.js";
export type { SupervisorDaemonOptions } from "./daemon.js";
export { SupervisorDaemon } from "./daemon.js";
// ─── Decisions ─────────────────────────────────────────────
export type { Decision, DecisionInput, DecisionOption } from "./decisions.js";
export {
  DecisionStore,
  decisionOptionSchema,
  decisionSchema,
} from "./decisions.js";
// ─── Directives ─────────────────────────────────────────────
export type { Directive, DirectiveCreateInput, DirectiveTrigger } from "./directive-store.js";
export { DirectiveStore, parseDirectiveDuration } from "./directive-store.js";
export type { DrainAndGroupResult, GroupedEvents, GroupedMessage } from "./event-queue.js";
export { EventQueue } from "./event-queue.js";
// ─── Failure reports ─────────────────────────────────────
export {
  buildSuggestedAction,
  classifyError,
  createFailureReport,
  writeFailureReport,
} from "./failure-report.js";
// ─── Focused Loop ─────────────────────────────────────
export type { FocusedLoopOptions } from "./focused-loop.js";
export { FocusedLoop } from "./focused-loop.js";
export type { HeartbeatLoopOptions, WebhookEventEmitter } from "./heartbeat.js";
export { HeartbeatLoop, shouldCompact, shouldConsolidate } from "./heartbeat.js";
// ─── Log buffer ─────────────────────────────────────────
export {
  appendLogBuffer,
  buildAgentDigest,
  compactLogBuffer,
  getLogBufferSize,
  markConsolidated,
  readLogBuffer,
  readLogBufferSince,
  readUnconsolidated,
} from "./log-buffer.js";
export type {
  Embedder,
  MemoryEntry,
  MemoryQuery,
  MemoryStats,
  MemoryType,
  MemoryWriteInput,
  SearchResult,
} from "./memory/index.js";
// ─── Memory store ──────────────────────────────────────
export {
  formatMemoriesForPrompt,
  MemoryStore,
  memoryEntrySchema,
  memoryTypeSchema,
  memoryWriteInputSchema,
} from "./memory/index.js";
export type {
  ConsolidationPromptOptions,
  PromptOptions,
} from "./prompt-builder.js";
// ─── Prompt builder ─────────────────────────────────────
export {
  buildCompactionPrompt,
  buildConsolidationPrompt,
  buildIdlePrompt,
  buildStandardPrompt,
  buildWorkQueueSection,
  isIdleHeartbeat,
} from "./prompt-builder.js";
export { StatusReader } from "./StatusReader.js";
// ─── Status ─────────────────────────────────────────────
// ─── Child schemas ─────────────────────────────────────
export type {
  ActivityEntry,
  ActivityQueryOptions,
  ActivityTypeFilter,
  ChildHandle,
  ChildToParentMessage,
  FailureReport,
  InboxMessage,
  InternalEventKind,
  LogBufferEntry,
  ParentToChildMessage,
  QueuedEvent,
  SupervisorDaemonState,
  SupervisorStatus,
  WakeReason,
  WebhookIncomingEvent,
} from "./schemas.js";
// ─── Schemas ────────────────────────────────────────────
export {
  activityEntrySchema,
  activityQueryOptionsSchema,
  activityTypeFilterSchema,
  failureReportSchema,
  inboxMessageSchema,
  internalEventKindSchema,
  logBufferEntrySchema,
  supervisorDaemonStateSchema,
  supervisorStatusSchema,
  wakeReasonSchema,
  webhookIncomingEventSchema,
} from "./schemas.js";
// ─── Shutdown ───────────────────────────────────────────
export type { ShutdownContext, ShutdownHandler, ShutdownOptions } from "./shutdown.js";
export {
  createShutdownManager,
  ShutdownManager,
  terminateGracefully,
  waitForExit,
} from "./shutdown.js";
// ─── Spawn child tool ───────────────────────────────────
export type { SpawnChildSupervisorInput } from "./spawn-child-tool.js";
export {
  SPAWN_CHILD_SUPERVISOR_TOOL,
  spawnChildSupervisorInputSchema,
} from "./spawn-child-tool.js";
// ─── JSONL Store ──────────────────────────────────────
export { JsonlSupervisorStore } from "./stores/jsonl.js";
// ─── Supervisor tools ──────────────────────────────────
export type {
  CriteriaResult,
  SupervisorBlockedInput,
  SupervisorCompleteInput,
  ToolDefinition,
} from "./supervisor-tools.js";
export {
  criteriaResultSchema,
  SUPERVISOR_BLOCKED_TOOL,
  SUPERVISOR_COMPLETE_TOOL,
  supervisorBlockedSchema,
  supervisorCompleteSchema,
} from "./supervisor-tools.js";

// ─── Other ──────────────────────────────────────────────
export { WebhookServer } from "./webhook-server.js";
// ─── Webhook events ──────────────────────────────────────
export type {
  HeartbeatEvent,
  RunCompletedEvent,
  RunDispatchedEvent,
  SupervisorStartedEvent,
  SupervisorStoppedEvent,
  SupervisorWebhookEvent,
} from "./webhookEvents.js";
export {
  heartbeatEventSchema,
  runCompletedEventSchema,
  runDispatchedEventSchema,
  supervisorStartedEventSchema,
  supervisorStoppedEventSchema,
  supervisorWebhookEventSchema,
} from "./webhookEvents.js";
