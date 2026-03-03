import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

// ─── Agent .md loader ────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR =
  process.env.AGENTS_DIR || path.resolve(__dirname, "../../.claude/agents");

/**
 * Load the full prompt from an agent's .md file.
 * Strips the YAML frontmatter and returns the markdown body.
 * Falls back to a minimal prompt if the file is not found.
 */
function loadAgentPrompt(agentName: string): string {
  const filePath = path.join(AGENTS_DIR, `${agentName}.md`);
  try {
    const content = readFileSync(filePath, "utf-8");
    // Strip YAML frontmatter (--- ... ---)
    const stripped = content.replace(/^---[\s\S]*?---\n*/, "");
    return stripped.trim();
  } catch {
    logger.warn(
      `Agent definition not found: ${filePath}. Using minimal prompt.`,
    );
    return `You are the ${agentName} agent in Voltaire Network.`;
  }
}

// ─── Agent definitions ───────────────────────────────────────
// Prompts are loaded from .claude/agents/*.md at startup.
// This ensures agents receive their FULL instructions, not truncated summaries.

export const agents: Record<string, AgentDefinition> = {
  // ─── architect ───────────────────────────────────────────────
  architect: {
    description:
      "Strategic planner and decomposer. Analyzes features, designs architecture, creates roadmaps, and decomposes work into atomic tasks. Never writes code.",
    prompt: loadAgentPrompt("architect"),
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    model: "opus",
  },

  // ─── developer ───────────────────────────────────────────────
  developer: {
    description:
      "Implementation worker. Executes atomic tasks from specs in isolated worktrees. Follows strict scope discipline.",
    prompt: loadAgentPrompt("developer"),
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model: "opus",
  },

  // ─── refiner ─────────────────────────────────────────────────
  refiner: {
    description:
      "Ticket quality evaluator and decomposer. Reads the target codebase to assess ticket clarity and split vague tickets into precise, implementable sub-tickets.",
    prompt: loadAgentPrompt("refiner"),
    tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
    model: "opus",
  },

  // ─── reviewer-quality ────────────────────────────────────────
  "reviewer-quality": {
    description:
      "Code quality reviewer. Checks DRY, naming, complexity, patterns, architecture, and import hygiene. Read-only.",
    prompt: loadAgentPrompt("reviewer-quality"),
    tools: ["Read", "Glob", "Grep"],
    model: "sonnet",
  },

  // ─── reviewer-security ───────────────────────────────────────
  "reviewer-security": {
    description:
      "Security auditor. Reviews for injection attacks, auth gaps, secrets exposure, and dependency vulnerabilities.",
    prompt: loadAgentPrompt("reviewer-security"),
    tools: ["Read", "Glob", "Grep", "Bash"],
    model: "opus",
  },

  // ─── reviewer-perf ───────────────────────────────────────────
  "reviewer-perf": {
    description:
      "Performance reviewer. Identifies N+1 queries, re-renders, bundle bloat, memory leaks, and algorithmic inefficiencies.",
    prompt: loadAgentPrompt("reviewer-perf"),
    tools: ["Read", "Glob", "Grep"],
    model: "sonnet",
  },

  // ─── reviewer-coverage ───────────────────────────────────────
  "reviewer-coverage": {
    description:
      "Test coverage reviewer. Identifies missing tests, untested edge cases, error paths, and over-mocking.",
    prompt: loadAgentPrompt("reviewer-coverage"),
    tools: ["Read", "Glob", "Grep", "Bash"],
    model: "sonnet",
  },

  // ─── qa-playwright ───────────────────────────────────────────
  "qa-playwright": {
    description:
      "QA agent with Playwright for E2E testing and visual regression.",
    prompt: loadAgentPrompt("qa-playwright"),
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    model: "sonnet",
  },

  // ─── fixer ───────────────────────────────────────────────────
  fixer: {
    description:
      "Auto-correction agent. Fixes issues found by reviewers and QA. Targets root causes, not symptoms.",
    prompt: loadAgentPrompt("fixer"),
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model: "opus",
  },
};
