// Shared types for the Voltaire Dispatch Service

// ─── Ticket types ──────────────────────────────────────────────
export type TicketType = "feature" | "bug" | "refactor" | "chore";
export type Priority = "critical" | "high" | "medium" | "low";
export type Complexity = 1 | 2 | 3 | 5 | 8 | 13 | 21 | 34 | 55 | 89 | 144;
export type PipelineType = "feature" | "review" | "hotfix" | "fixer" | "refine";

export interface SanitizedTicket {
  ticketId: string;
  title: string;
  type: TicketType;
  priority: Priority;
  complexity: Complexity;
  criteria: string;
  description: string;
  repository: string;
}

// ─── Dispatch request payloads ─────────────────────────────────
export interface FeatureRequest {
  ticketId: string;
  notionTicketId?: string;
  title: string;
  type: TicketType;
  priority: Priority;
  complexity: Complexity;
  repository: string;
  criteria: string;
  description: string;
  skills?: string[];
}

export interface ReviewRequest {
  ticketId: string;
  prNumber: number;
  repository: string;
  skills?: string[];
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
  ticketId: string;
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
  repository?: string;
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
  stopReason?: string;
  errorType?: string;
  errorMessage?: string;
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
  worktreePath?: string;
  repoDir?: string;
}

// ─── Status response ───────────────────────────────────────────
export interface ServiceStatus {
  paused: boolean;
  activeSessions: ActiveSession[];
  queueDepth: number;
  totalCostToday: number;
  budgetCapUsd: number;
  budgetRemainingUsd: number;
  budgetUtilizationPct: number;
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
  | "refine.subtasks"
  | "service.started"
  | "service.stopped"
  | "agent.notification";

export interface SubTicketsCallbackData {
  ticketId: string;
  subTickets: SubTicket[];
}

export interface CallbackPayload {
  event: CallbackEvent;
  timestamp: string;
  data: PipelineResult | RefineResult | ServiceEventData | AgentNotificationData | SubTicketsCallbackData;
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

// ─── Refine pipeline ─────────────────────────────────────────
export interface RefineRequest {
  ticketId: string;
  title: string;
  type: TicketType;
  priority: Priority;
  complexity?: Complexity;
  repository: string;
  criteria?: string;
  description?: string;
}

export interface SubTicket {
  id: string;
  title: string;
  type: TicketType;
  priority: Priority;
  complexity: 1 | 2;
  files: string[];
  criteria: string[];
  depends_on: string[];
  description: string;
}

export interface RefineResult {
  ticketId: string;
  sessionId: string;
  pipeline: "refine";
  status: PipelineStatus;
  score: number;
  reason: string;
  action: "pass_through" | "decompose" | "escalate";
  enrichedContext?: Record<string, unknown>;
  subTickets?: SubTicket[];
  questions?: string[];
  costUsd: number;
  durationMs: number;
  timestamp: string;
}
