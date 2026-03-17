import type { McpServerConfig } from "@/config";
import { buildSandboxConfig } from "@/isolation/sandbox";
import { buildMiddlewareChain, buildSDKHooks } from "@/middleware/chain";
import type { ParsedOutput } from "@/runner/output-parser";
import { parseOutput } from "@/runner/output-parser";
import { runWithRecovery } from "@/runner/recovery";
import type { SessionResult } from "@/runner/session";
import type {
  Middleware,
  MiddlewareContext,
  ResolvedAgent,
  StepResult,
  WorkflowStepDef,
} from "@/types";

// ─── Types ──────────────────────────────────────────────

/**
 * Input for executing a session. Contains all the context needed
 * to spawn a Claude session and process its output.
 */
export interface SessionExecutionInput {
  /** The resolved agent to run */
  agent: ResolvedAgent;
  /** The full prompt (already assembled with repo instructions, git context, etc.) */
  prompt: string;
  /** Path to the repository (for readonly agents or reference) */
  repoPath: string;
  /** Path to the session clone (for writable agents) */
  sessionPath?: string | undefined;
  /** MCP servers to attach to the session */
  mcpServers?: Record<string, McpServerConfig> | undefined;
  /** Environment variables to inject */
  env?: Record<string, string> | undefined;
  /** Session configuration from NeoConfig */
  sessionConfig: {
    initTimeoutMs: number;
    maxDurationMs: number;
  };
  /** Recovery configuration */
  recoveryConfig: {
    maxRetries: number;
    backoffBaseMs: number;
    nonRetryable?: string[] | undefined;
  };
  /** User-provided middleware */
  middleware: Middleware[];
  /** Middleware context for hook execution */
  middlewareContext: MiddlewareContext;
  /** Callback fired on each recovery attempt */
  onAttempt?: ((attempt: number, strategy: string) => void) | undefined;
}

/**
 * Output from a session execution. Includes both the raw session result
 * and the parsed/processed output.
 */
export interface SessionExecutionResult {
  /** Session ID from the SDK */
  sessionId: string;
  /** Parsed output (may include structured data, PR URL, etc.) */
  parsed: ParsedOutput;
  /** Raw session result from runWithRecovery */
  sessionResult: SessionResult;
  /** Duration of the session in milliseconds */
  durationMs: number;
  /** Total cost of the session in USD */
  costUsd: number;
}

/**
 * Options for building a StepResult from a SessionExecutionResult.
 */
export interface StepResultOptions {
  agent: string;
  startedAt: string;
}

// ─── Session Executor ───────────────────────────────────

/**
 * Execute a Claude session with the given input.
 *
 * This function handles:
 * - Building sandbox configuration based on agent type
 * - Setting up middleware chain and SDK hooks
 * - Running the session with recovery (3-level escalation)
 * - Parsing the output for structured data and markers
 *
 * @param input - Session execution input
 * @returns Session execution result
 */
export async function executeSession(
  input: SessionExecutionInput,
): Promise<SessionExecutionResult> {
  const {
    agent,
    prompt,
    repoPath,
    sessionPath,
    mcpServers,
    env,
    sessionConfig,
    recoveryConfig,
    middleware,
    middlewareContext,
    onAttempt,
  } = input;

  const sandboxConfig = buildSandboxConfig(agent, sessionPath);
  const chain = buildMiddlewareChain(middleware);
  const hooks = buildSDKHooks(chain, middlewareContext, middleware);

  const sessionResult = await runWithRecovery({
    agent,
    prompt,
    repoPath,
    sandboxConfig,
    hooks,
    initTimeoutMs: sessionConfig.initTimeoutMs,
    maxDurationMs: sessionConfig.maxDurationMs,
    maxRetries: recoveryConfig.maxRetries,
    backoffBaseMs: recoveryConfig.backoffBaseMs,
    ...(sessionPath ? { sessionPath } : {}),
    ...(env ? { env } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(recoveryConfig.nonRetryable ? { nonRetryable: recoveryConfig.nonRetryable } : {}),
    ...(onAttempt ? { onAttempt } : {}),
  });

  const parsed = parseOutput(sessionResult.output);

  return {
    sessionId: sessionResult.sessionId,
    parsed,
    sessionResult,
    durationMs: sessionResult.durationMs,
    costUsd: sessionResult.costUsd,
  };
}

/**
 * Build a StepResult from a SessionExecutionResult.
 *
 * This is a convenience function for converting session results
 * into the StepResult format used by the orchestrator.
 *
 * @param result - Session execution result
 * @param options - Additional options for building the StepResult
 * @returns A StepResult with success status
 */
export function buildStepResult(
  result: SessionExecutionResult,
  options: StepResultOptions,
): StepResult {
  const stepResult: StepResult = {
    status: "success",
    sessionId: result.sessionId,
    output: result.parsed.output ?? result.parsed.rawOutput,
    rawOutput: result.sessionResult.output,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    agent: options.agent,
    startedAt: options.startedAt,
    completedAt: new Date().toISOString(),
    attempt: 1,
  };

  if (result.parsed.prUrl) {
    stepResult.prUrl = result.parsed.prUrl;
  }
  if (result.parsed.prNumber !== undefined) {
    stepResult.prNumber = result.parsed.prNumber;
  }

  return stepResult;
}

/**
 * Build a failed StepResult for error cases.
 *
 * @param error - The error that caused the failure
 * @param options - Additional options for building the StepResult
 * @returns A StepResult with failure status
 */
export function buildFailedStepResult(
  error: unknown,
  options: StepResultOptions & { sessionId: string; durationMs: number },
): StepResult {
  const errorMsg = error instanceof Error ? error.message : String(error);

  return {
    status: "failure",
    sessionId: options.sessionId,
    costUsd: 0,
    durationMs: options.durationMs,
    agent: options.agent,
    startedAt: options.startedAt,
    completedAt: new Date().toISOString(),
    error: errorMsg,
    attempt: 1,
  };
}

// ─── Sandbox Config Builder ─────────────────────────────

export type { SandboxConfig } from "@/isolation/sandbox";
/**
 * Build a SandboxConfig for a session.
 *
 * Re-exports buildSandboxConfig from isolation/sandbox for convenience.
 * This allows session-executor to be a single import for session execution needs.
 */
export { buildSandboxConfig } from "@/isolation/sandbox";

// ─── MCP Server Resolution ──────────────────────────────

/**
 * Resolve MCP servers for a step from config, step definition, and agent definition.
 *
 * @param stepDef - The workflow step definition
 * @param agent - The resolved agent
 * @param configServers - MCP servers from NeoConfig
 * @returns Resolved MCP server configs, or undefined if none
 */
export function resolveMcpServers(
  stepDef: WorkflowStepDef,
  agent: ResolvedAgent,
  configServers: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!configServers) return undefined;

  // Collect unique server names from step definition and agent definition
  const names = new Set<string>();
  if (stepDef.mcpServers) {
    for (const name of stepDef.mcpServers) names.add(name);
  }
  if (agent.definition.mcpServers) {
    for (const name of agent.definition.mcpServers) names.add(name);
  }

  if (names.size === 0) return undefined;

  const resolved: Record<string, McpServerConfig> = {};
  for (const name of names) {
    const serverConfig = configServers[name];
    if (serverConfig) {
      resolved[name] = serverConfig;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

// ─── Middleware Context Builder ─────────────────────────

/**
 * Build a MiddlewareContext for a session.
 *
 * @param params - Context parameters
 * @param getters - Optional getters for well-known context values
 * @returns A MiddlewareContext instance
 */
export function buildMiddlewareContext(
  params: {
    runId: string;
    workflow: string;
    step: string;
    agent: string;
    repo: string;
  },
  getters?: {
    getCostToday?: () => number;
    getBudgetCapUsd?: () => number;
  },
): MiddlewareContext {
  const store = new Map<string, unknown>();

  return {
    runId: params.runId,
    workflow: params.workflow,
    step: params.step,
    agent: params.agent,
    repo: params.repo,
    get: ((key: string) => {
      if (key === "costToday" && getters?.getCostToday) return getters.getCostToday();
      if (key === "budgetCapUsd" && getters?.getBudgetCapUsd) return getters.getBudgetCapUsd();
      return store.get(key);
    }) as MiddlewareContext["get"],
    set: ((key: string, value: unknown) => {
      store.set(key, value);
    }) as MiddlewareContext["set"],
  };
}
