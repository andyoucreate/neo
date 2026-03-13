export { loadAgentFile } from "./agents/loader.js";
export { AgentRegistry } from "./agents/registry.js";
export { resolveAgent } from "./agents/resolver.js";
export {
  agentConfigSchema,
  agentModelSchema,
  agentSandboxSchema,
  agentToolEntrySchema,
  agentToolSchema,
} from "./agents/schema.js";
export {
  loadConfig,
  mcpServerConfigSchema,
  neoConfigSchema,
  repoConfigSchema,
} from "./config.js";
export {
  createBranch,
  deleteBranch,
  fetchRemote,
  getBranchName,
  getCurrentBranch,
  pushBranch,
} from "./isolation/git.js";

// ─── Isolation ──────────────────────────────────────────
export { withGitLock } from "./isolation/git-mutex.js";
export type { SandboxConfig } from "./isolation/sandbox.js";
export { buildSandboxConfig } from "./isolation/sandbox.js";
export type { WorktreeInfo } from "./isolation/worktree.js";
export {
  cleanupOrphanedWorktrees,
  createWorktree,
  listWorktrees,
  removeWorktree,
} from "./isolation/worktree.js";
export * from "./types.js";
