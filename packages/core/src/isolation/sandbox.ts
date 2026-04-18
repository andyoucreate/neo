import { resolve } from "node:path";
import type { ResolvedAgent } from "@/types";

/**
 * SDK-compatible sandbox configuration.
 * Controls which tools an agent can use and which paths it can access.
 */
export interface SandboxConfig {
  /** Tools the agent is allowed to use */
  allowedTools: string[];
  /** Directories the agent can read from */
  readablePaths: string[];
  /** Directories the agent can write to (empty for readonly agents) */
  writablePaths: string[];
  /** Whether the agent has write access */
  writable: boolean;
}

/**
 * Build an SDK-compatible sandbox configuration for an agent.
 *
 * - Writable agents: all their tools are allowed, write paths include the session clone
 * - Readonly agents: write tools are filtered out, no writable paths
 */
export function buildSandboxConfig(agent: ResolvedAgent, sessionPath?: string): SandboxConfig {
  const isWritable = agent.sandbox === "writable";
  const absSession = sessionPath ? resolve(sessionPath) : undefined;

  const allowedTools: string[] = [];

  const readablePaths = absSession ? [absSession] : [];
  const writablePaths = isWritable && absSession ? [absSession] : [];

  return {
    allowedTools,
    readablePaths,
    writablePaths,
    writable: isWritable,
  };
}
