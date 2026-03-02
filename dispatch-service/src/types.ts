// Shared types for the Voltaire Dispatch Service

// ─── Ticket types ──────────────────────────────────────────────
export type TicketType = "feature" | "bug" | "refactor" | "chore";
export type Priority = "critical" | "high" | "medium" | "low";
export type Size = "xs" | "s" | "m" | "l" | "xl";
export type PipelineType = "feature" | "review" | "qa" | "hotfix" | "fixer";

export interface SanitizedTicket {
  ticketId: string;
  title: string;
  type: TicketType;
  priority: Priority;
  size: Size;
  criteria: string;
  description: string;
  repository: string;
}

// ─── Dispatch request payloads ─────────────────────────────────
export interface FeatureRequest {
  ticketId: string;
  title: string;
  type: TicketType;
  priority: Priority;
  size: Size;
  repository: string;
  criteria: string;
  description: string;
  skills?: string[];
}

export interface ReviewRequest {
  prNumber: number;
  repository: string;
  skills?: string[];
}

export interface QaRequest {
  prNumber: number;
  repository: string;
}

export interface HotfixRequest {
  ticketId: string;
  title: string;
  priority: Priority;
  repository: string;
  description: string;
  skills?: string[];
}

export interface FixerIssue {
  source: string;
  severity: "CRITICAL" | "HIGH" | "WARNING";
  file: string;
  line: number;
  description: string;
  suggestion?: string;
}

export interface FixerRequest {
  prNumber: number;
  repository: string;
  issues: FixerIssue[];
}

// ─── Dispatch response ─────────────────────────────────────────
export interface DispatchReceipt {
  status: "dispatched" | "queued";
  sessionId: string;
  pipeline: PipelineType;
  queuePosition?: number;
}

// ─── Pipeline result ───────────────────────────────────────────
export type PipelineStatus = "success" | "failure" | "timeout" | "cancelled";

export interface PipelineResult {
  ticketId?: string;
  sessionId: string;
  pipeline: PipelineType;
  status: PipelineStatus;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  summary?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  reviewFindings?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  durationMs: number;
  costUsd: number;
  timestamp: string;
}

// ─── Session tracking ──────────────────────────────────────────
export interface ActiveSession {
  sessionId: string;
  pipeline: PipelineType;
  repository: string;
  ticketId?: string;
  prNumber?: number;
  startedAt: string;
  status: "running" | "queued";
}

// ─── Status response ───────────────────────────────────────────
export interface ServiceStatus {
  paused: boolean;
  activeSessions: ActiveSession[];
  queueDepth: number;
  totalCostToday: number;
  uptime: number;
}

// ─── Cost journal entry ────────────────────────────────────────
export interface CostEntry {
  ts: string;
  pipeline: PipelineType;
  sessionId: string;
  ticketId?: string;
  costUsd: number;
  models: Record<string, number>;
  durationMs: number;
}

// ─── Concurrency ───────────────────────────────────────────────
export interface ConcurrencyLimits {
  maxConcurrentSessions: number;
  maxConcurrentPerProject: number;
  queueMaxSize: number;
  dispatchCooldownMs: number;
}

// ─── Callback to OpenClaw ─────────────────────────────────────
export type CallbackEvent =
  | "pipeline.completed"
  | "pipeline.failed"
  | "service.started"
  | "service.stopped"
  | "agent.notification";

export interface CallbackPayload {
  event: CallbackEvent;
  timestamp: string;
  data: PipelineResult | ServiceEventData | AgentNotificationData;
}

export interface ServiceEventData {
  action: "started" | "stopped";
  version: string;
  host: string;
  signal?: string;
}

export interface AgentNotificationData {
  sessionId: string;
  message: string;
}
