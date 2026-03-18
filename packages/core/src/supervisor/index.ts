// ─── Components ──────────────────────────────────────────
export { ActivityLog } from "./activity-log.js";
export type { SupervisorDaemonOptions } from "./daemon.js";
export { SupervisorDaemon } from "./daemon.js";
// ─── Decisions ─────────────────────────────────────────────
export type { Decision, DecisionInput, DecisionOption } from "./decisions.js";
export {
  DecisionStore,
  decisionOptionSchema,
  decisionSchema,
} from "./decisions.js";
export type { DrainAndGroupResult, GroupedEvents, GroupedMessage } from "./event-queue.js";
export { EventQueue } from "./event-queue.js";
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
} from "./memory/index.js";
// ─── Memory store ──────────────────────────────────────
export {
  cosineSimilarity,
  formatMemoriesForPrompt,
  LocalEmbedder,
  MemoryStore,
  memoryEntrySchema,
  memoryTypeSchema,
  memoryWriteInputSchema,
} from "./memory/index.js";
export type {
  ConsolidationPromptOptions,
  PromptOptions,
  StandardPromptOptions,
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
export type {
  ActivityEntry,
  ActivityQueryOptions,
  ActivityTypeFilter,
  InboxMessage,
  InternalEventKind,
  LogBufferEntry,
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
