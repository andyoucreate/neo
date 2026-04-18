import { resolve } from "node:path";
import type { ResolvedAgent } from "@/types";

/**
 * SDK-compatible sandbox configuration.
 * Controls which paths an agent can access.
 */
export interface SandboxConfig {
  /** Whether the agent has write access */
  writable: boolean;
  /** Directories the agent can read from and write to */
  paths: {
    readable: string[];
    writable: string[];
  };
}

/**
 * Build an SDK-compatible sandbox configuration for an agent.
 *
 * - Writable agents: write paths include the session clone
 * - Readonly agents: no writable paths
 */
export function buildSandboxConfig(agent: ResolvedAgent, sessionPath?: string): SandboxConfig {
  const isWritable = agent.sandbox === "writable";
  const absSession = sessionPath ? resolve(sessionPath) : undefined;

  const readable = absSession ? [absSession] : [];
  const writable = isWritable && absSession ? [absSession] : [];

  return {
    writable: isWritable,
    paths: { readable, writable },
  };
}
