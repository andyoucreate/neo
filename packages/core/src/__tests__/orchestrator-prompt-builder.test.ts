import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCwdInstructions,
  buildFullPrompt,
  buildGitStrategyInstructions,
  buildReportingInstructions,
  loadRepoInstructions,
} from "@/prompt-builder";
import type { ResolvedAgent } from "@/types";

// ─── Test fixtures ─────────────────────────────────────

function makeAgent(overrides?: Partial<ResolvedAgent>): ResolvedAgent {
  return {
    name: "test-agent",
    sandbox: "writable",
    source: "built-in",
    definition: {
      description: "Test agent",
      prompt: "You are a test agent.",
      tools: ["Bash", "Read", "Write"],
      model: "claude-sonnet-4-20250514",
    },
    ...overrides,
  };
}

// ─── loadRepoInstructions ──────────────────────────────

describe("loadRepoInstructions", () => {
  const tmpDir = `/tmp/neo-test-prompt-builder-${Date.now()}`;

  beforeAll(async () => {
    await mkdir(path.join(tmpDir, ".neo"), { recursive: true });
    await writeFile(
      path.join(tmpDir, ".neo/INSTRUCTIONS.md"),
      "# Custom Instructions\n\nUse TypeScript strict mode.",
    );
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns instructions when file exists", async () => {
    const result = await loadRepoInstructions(tmpDir);
    expect(result).toContain("Custom Instructions");
    expect(result).toContain("TypeScript strict mode");
  });

  it("returns undefined when file does not exist", async () => {
    const result = await loadRepoInstructions("/non-existent-path");
    expect(result).toBeUndefined();
  });
});

// ─── buildGitStrategyInstructions ──────────────────────

describe("buildGitStrategyInstructions", () => {
  it("returns null for readonly agents without PR", () => {
    const result = buildGitStrategyInstructions({
      strategy: "branch",
      agent: makeAgent({ sandbox: "readonly" }),
      branch: "",
      baseBranch: "main",
      remote: "origin",
    });
    expect(result).toBeNull();
  });

  it("returns PR comment instruction for readonly agents with PR", () => {
    const result = buildGitStrategyInstructions({
      strategy: "branch",
      agent: makeAgent({ sandbox: "readonly" }),
      branch: "",
      baseBranch: "main",
      remote: "origin",
      metadata: { prNumber: 42 },
    });
    expect(result).toContain("PR #42");
    expect(result).toContain("gh pr comment 42");
  });

  it("returns branch strategy instructions for writable agents", () => {
    const result = buildGitStrategyInstructions({
      strategy: "branch",
      agent: makeAgent({ sandbox: "writable" }),
      branch: "feat/test",
      baseBranch: "main",
      remote: "origin",
    });
    expect(result).toContain("## Git workflow");
    expect(result).toContain("feat/test");
    expect(result).toContain("main");
    expect(result).toContain("pushed automatically");
  });

  it("returns PR strategy instructions for writable agents without existing PR", () => {
    const result = buildGitStrategyInstructions({
      strategy: "pr",
      agent: makeAgent({ sandbox: "writable" }),
      branch: "feat/new-feature",
      baseBranch: "main",
      remote: "origin",
    });
    expect(result).toContain("git push -u origin feat/new-feature");
    expect(result).toContain("Create a PR");
    expect(result).toContain("PR_URL:");
  });

  it("returns PR update instructions for writable agents with existing PR", () => {
    const result = buildGitStrategyInstructions({
      strategy: "pr",
      agent: makeAgent({ sandbox: "writable" }),
      branch: "feat/existing",
      baseBranch: "main",
      remote: "origin",
      metadata: { prNumber: 123 },
    });
    expect(result).toContain("#123");
    expect(result).toContain("PR will be updated automatically");
    expect(result).toContain("gh pr comment 123");
  });
});

// ─── buildReportingInstructions ────────────────────────

describe("buildReportingInstructions", () => {
  it("includes neo log examples", () => {
    const result = buildReportingInstructions("run-123");
    expect(result).toContain("## Reporting & Memory");
    expect(result).toContain("neo log milestone");
    expect(result).toContain("neo log action");
    expect(result).toContain("neo log decision");
  });

  it("includes memory write examples", () => {
    const result = buildReportingInstructions("run-456");
    expect(result).toContain("neo memory write");
    expect(result).toContain("--type fact");
    expect(result).toContain("--type procedure");
    expect(result).toContain("$NEO_REPOSITORY");
  });
});

// ─── buildCwdInstructions ──────────────────────────────

describe("buildCwdInstructions", () => {
  it("includes session path in instructions", () => {
    const result = buildCwdInstructions("/tmp/neo-sessions/abc123");
    expect(result).toContain("## Working directory");
    expect(result).toContain("/tmp/neo-sessions/abc123");
    expect(result).toContain("ALWAYS run commands from this directory");
  });
});

// ─── buildFullPrompt ───────────────────────────────────

describe("buildFullPrompt", () => {
  it("combines all sections with separators", () => {
    const result = buildFullPrompt({
      agentPrompt: "You are a developer.",
      repoInstructions: "Use pnpm.",
      gitInstructions: "## Git\n\nCommit changes.",
      taskPrompt: "Fix the bug.",
      memoryContext: "Known: Uses TypeScript.",
      cwdInstructions: "## Working directory\n\nPath: /tmp/test",
      reportingInstructions: "## Reporting\n\nUse neo log.",
    });

    // Check all sections are present
    expect(result).toContain("You are a developer.");
    expect(result).toContain("## Repository instructions");
    expect(result).toContain("Use pnpm.");
    expect(result).toContain("## Git");
    expect(result).toContain("Commit changes.");
    expect(result).toContain("## Task");
    expect(result).toContain("Fix the bug.");
    expect(result).toContain("Known: Uses TypeScript.");
    expect(result).toContain("## Working directory");
    expect(result).toContain("## Reporting");

    // Check separators
    expect(result).toContain("---");
  });

  it("handles optional sections", () => {
    const result = buildFullPrompt({
      agentPrompt: undefined,
      repoInstructions: undefined,
      gitInstructions: null,
      taskPrompt: "Simple task.",
    });

    expect(result).toContain("## Task");
    expect(result).toContain("Simple task.");
    expect(result).not.toContain("Repository instructions");
    expect(result).not.toContain("Git workflow");
  });

  it("orders sections correctly", () => {
    const result = buildFullPrompt({
      agentPrompt: "AGENT_START",
      repoInstructions: "REPO_MIDDLE",
      gitInstructions: "GIT_AFTER_REPO",
      taskPrompt: "TASK_END",
      cwdInstructions: "CWD_AFTER_AGENT",
      memoryContext: "MEMORY_AFTER_CWD",
      reportingInstructions: "REPORTING_BEFORE_TASK",
    });

    const agentPos = result.indexOf("AGENT_START");
    const cwdPos = result.indexOf("CWD_AFTER_AGENT");
    const memoryPos = result.indexOf("MEMORY_AFTER_CWD");
    const repoPos = result.indexOf("REPO_MIDDLE");
    const gitPos = result.indexOf("GIT_AFTER_REPO");
    const reportingPos = result.indexOf("REPORTING_BEFORE_TASK");
    const taskPos = result.indexOf("TASK_END");

    // Verify order: agent → cwd → memory → repo → git → reporting → task
    expect(agentPos).toBeLessThan(cwdPos);
    expect(cwdPos).toBeLessThan(memoryPos);
    expect(memoryPos).toBeLessThan(repoPos);
    expect(repoPos).toBeLessThan(gitPos);
    expect(gitPos).toBeLessThan(reportingPos);
    expect(reportingPos).toBeLessThan(taskPos);
  });
});
