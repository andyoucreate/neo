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

/** Tools that modify the filesystem */
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

/**
 * Build an SDK-compatible sandbox configuration for an agent.
 *
 * - Writable agents: all their tools are allowed, write paths include the worktree
 * - Readonly agents: write tools are filtered out, no writable paths
 */
export function buildSandboxConfig(agent: ResolvedAgent, worktreePath?: string): SandboxConfig {
  const isWritable = agent.sandbox === "writable";
  const absWorktree = worktreePath ? resolve(worktreePath) : undefined;

  const allowedTools = isWritable
    ? agent.definition.tools
    : agent.definition.tools.filter((t) => !WRITE_TOOLS.has(t));

  const readablePaths = absWorktree ? [absWorktree] : [];
  const writablePaths = isWritable && absWorktree ? [absWorktree] : [];

  return {
    allowedTools,
    readablePaths,
    writablePaths,
    writable: isWritable,
  };
}
