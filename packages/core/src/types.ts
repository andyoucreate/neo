// Re-export Zod-derived config types (single source of truth)

// Re-export Zod-derived agent types (single source of truth)
export type {
  AgentConfig,
  AgentModel,
  AgentTool,
  AgentToolEntry,
} from "@/agents/schema";
export type { GitStrategy, McpServerConfig, NeoConfig, RepoConfig } from "@/config";

// ─── Agent Definition (SDK-compatible) ───────────────────

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model: string;
  mcpServers?: string[] | undefined;
}

// ─── Resolved agent (runtime, after merging) ─────────────

export interface ResolvedAgent {
  name: string;
  definition: AgentDefinition;
  sandbox: "writable" | "readonly";
  maxTurns?: number | undefined;
  source: "built-in" | "custom" | "extended";
}

// ─── Run Persistence ─────────────────────────────────────

export interface PersistedRun {
  version: 1;
  runId: string;
  agent: string;
  repo: string;
  prompt: string;
  branch?: string | undefined;
  sessionPath?: string | undefined;
  pid?: number | undefined;
  status: "running" | "paused" | "completed" | "failed";
  steps: Record<string, StepResult>;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface StepResult {
  status: "pending" | "running" | "success" | "failure" | "skipped";
  sessionId?: string | undefined;
  output?: unknown;
  rawOutput?: string | undefined;
  prUrl?: string | undefined;
  prNumber?: number | undefined;
  costUsd: number;
  durationMs: number;
  agent: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  error?: string | undefined;
  attempt: number;
}

// ─── Dispatch ────────────────────────────────────────────

export type Priority = "critical" | "high" | "medium" | "low";

export interface DispatchInput {
  agent: string;
  repo: string;
  prompt: string;
  runId?: string | undefined;
  branch?: string | undefined;
  step?: string | undefined;
  from?: string | undefined;
  retry?: string | undefined;
  priority?: Priority | undefined;
  gitStrategy?: "pr" | "branch" | undefined;
  overrides?:
    | {
        agents?: Record<string, string> | undefined;
        maxTurns?: number | undefined;
        sandbox?: "writable" | "readonly" | undefined;
      }
    | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TaskResult {
  runId: string;
  agent: string;
  repo: string;
  status: "success" | "failure" | "timeout" | "cancelled";
  steps: Record<string, StepResult>;
  prUrl?: string | undefined;
  prNumber?: number | undefined;
  branch?: string | undefined;
  summary?: string | undefined;
  costUsd: number;
  durationMs: number;
  timestamp: string;
  metadata?: Record<string, unknown> | undefined;
}

// ─── Sessions ────────────────────────────────────────────

export interface ActiveSession {
  sessionId: string;
  runId: string;
  step: string;
  agent: string;
  repo: string;
  status: "running" | "queued" | "waiting_gate";
  startedAt: string;
  sessionPath?: string | undefined;
}

export interface OrchestratorStatus {
  paused: boolean;
  activeSessions: ActiveSession[];
  queueDepth: number;
  costToday: number;
  budgetCapUsd: number;
  budgetRemainingPct: number;
  uptime: number;
}

// ─── Run Context ─────────────────────────────────────────

export interface RunContext {
  runId: string;
  agent: string;
  repo: string;
  prompt: string;
  steps: Record<string, StepResult>;
  startedAt: Date;
}

// ─── Events ──────────────────────────────────────────────

export interface SessionStartEvent {
  type: "session:start";
  sessionId: string;
  runId: string;
  step: string;
  agent: string;
  repo: string;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface SessionCompleteEvent {
  type: "session:complete";
  sessionId: string;
  runId: string;
  status: "success" | "failure";
  costUsd: number;
  durationMs: number;
  output?: unknown;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface SessionFailEvent {
  type: "session:fail";
  sessionId: string;
  runId: string;
  error: string;
  attempt: number;
  maxRetries: number;
  willRetry: boolean;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface AgentToolUseEvent {
  type: "agent:tool_use";
  sessionId: string;
  agent: string;
  tool: string;
  input: Record<string, unknown>;
  durationMs: number;
  timestamp: string;
}

export interface AgentMessageEvent {
  type: "agent:message";
  sessionId: string;
  agent: string;
  text: string;
  timestamp: string;
}

export interface StepStartEvent {
  type: "step:start";
  runId: string;
  step: string;
  agent: string;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface StepCompleteEvent {
  type: "step:complete";
  runId: string;
  step: string;
  status: "success" | "failure" | "skipped";
  costUsd: number;
  durationMs: number;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface GateWaitingEvent {
  type: "gate:waiting";
  runId: string;
  gate: string;
  description: string;
  context: RunContext;
  approve: () => void;
  reject: (reason: string) => void;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface CostUpdateEvent {
  type: "cost:update";
  sessionId: string;
  sessionCost: number;
  todayTotal: number;
  budgetRemainingPct: number;
  timestamp: string;
}

export interface BudgetAlertEvent {
  type: "budget:alert";
  todayTotal: number;
  capUsd: number;
  utilizationPct: number;
  timestamp: string;
}

export interface QueueEnqueueEvent {
  type: "queue:enqueue";
  sessionId: string;
  repo: string;
  position: number;
  timestamp: string;
}

export interface QueueDequeueEvent {
  type: "queue:dequeue";
  sessionId: string;
  repo: string;
  waitedMs: number;
  timestamp: string;
}

export interface OrchestratorShutdownEvent {
  type: "orchestrator:shutdown";
  timestamp: string;
}

export type NeoEvent =
  | SessionStartEvent
  | SessionCompleteEvent
  | SessionFailEvent
  | AgentToolUseEvent
  | AgentMessageEvent
  | StepStartEvent
  | StepCompleteEvent
  | GateWaitingEvent
  | CostUpdateEvent
  | BudgetAlertEvent
  | QueueEnqueueEvent
  | QueueDequeueEvent
  | OrchestratorShutdownEvent;

// ─── Middleware ───────────────────────────────────────────

export type HookEvent = "PreToolUse" | "PostToolUse" | "Notification";

export interface Middleware {
  name: string;
  on: HookEvent;
  match?: string | string[] | undefined;
  handler: MiddlewareHandler;
}

export type MiddlewareHandler = (
  event: MiddlewareEvent,
  context: MiddlewareContext,
) => Promise<MiddlewareResult>;

export interface MiddlewareEvent {
  hookEvent: HookEvent;
  sessionId: string;
  toolName?: string | undefined;
  input?: Record<string, unknown> | undefined;
  output?: string | undefined;
  message?: string | undefined;
}

/** Well-known context keys set by the orchestrator. */
export interface MiddlewareContextMap {
  costToday: number;
  budgetCapUsd: number;
  [key: string]: unknown;
}

export interface MiddlewareContext {
  runId: string;
  step: string;
  agent: string;
  repo: string;
  get: <K extends string & keyof MiddlewareContextMap>(
    key: K,
  ) => MiddlewareContextMap[K] | undefined;
  set: <K extends string & keyof MiddlewareContextMap>(
    key: K,
    value: MiddlewareContextMap[K],
  ) => void;
}

export type MiddlewareResult =
  | { decision: "pass" }
  | { decision: "block"; reason: string }
  | { decision: "async"; asyncTimeout: number };

// ─── Cost & Metrics ─────────────────────────────────────

export interface CostEntry {
  timestamp: string;
  runId: string;
  step: string;
  sessionId: string;
  agent: string;
  costUsd: number;
  models: Record<string, number>;
  durationMs: number;
  repo?: string;
}
