import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFullPrompt,
  buildGitStrategyInstructions,
  buildReportingInstructions,
  loadRepoInstructions,
} from "@/orchestrator/prompt-builder";
import type { ResolvedAgent } from "@/types";

// ─── Helpers ────────────────────────────────────────────

const TMP_DIR = path.join(import.meta.dirname, "__tmp_prompt_builder_test__");

function makeAgent(overrides?: Partial<ResolvedAgent>): ResolvedAgent {
  return {
    name: "test-developer",
    definition: {
      description: "Test developer agent",
      prompt: "You are a test agent.",
      tools: ["Read", "Write", "Edit", "Bash"],
      model: "sonnet",
    },
    sandbox: "writable",
    source: "built-in",
    ...overrides,
  };
}

// ─── Setup / Teardown ───────────────────────────────────

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── loadRepoInstructions ───────────────────────────────

describe("loadRepoInstructions", () => {
  it("returns undefined when .neo/INSTRUCTIONS.md does not exist", async () => {
    const result = await loadRepoInstructions(TMP_DIR);
    expect(result).toBeUndefined();
  });

  it("returns file contents when .neo/INSTRUCTIONS.md exists", async () => {
    const neoDir = path.join(TMP_DIR, ".neo");
    await mkdir(neoDir, { recursive: true });
    await writeFile(
      path.join(neoDir, "INSTRUCTIONS.md"),
      "# Custom Instructions\n\nFollow these rules.",
    );

    const result = await loadRepoInstructions(TMP_DIR);
    expect(result).toBe("# Custom Instructions\n\nFollow these rules.");
  });
});

// ─── buildGitStrategyInstructions ───────────────────────

describe("buildGitStrategyInstructions", () => {
  describe("readonly agents", () => {
    it("returns null for readonly agent without PR", () => {
      const agent = makeAgent({ sandbox: "readonly" });
      const result = buildGitStrategyInstructions("branch", agent, "main", "main", "origin");
      expect(result).toBeNull();
    });

    it("returns PR comment instruction for readonly agent with PR", () => {
      const agent = makeAgent({ sandbox: "readonly" });
      const result = buildGitStrategyInstructions("branch", agent, "main", "main", "origin", {
        prNumber: 42,
      });
      expect(result).toContain("PR #42");
      expect(result).toContain("gh pr comment 42");
    });
  });

  describe("writable agents with branch strategy", () => {
    it("returns branch commit instruction", () => {
      const agent = makeAgent({ sandbox: "writable" });
      const result = buildGitStrategyInstructions(
        "branch",
        agent,
        "feat/new-feature",
        "main",
        "origin",
      );
      expect(result).toContain("feat/new-feature");
      expect(result).toContain("main");
      expect(result).toContain("Commit your changes");
      expect(result).toContain("pushed automatically");
    });
  });

  describe("writable agents with pr strategy", () => {
    it("returns PR creation instructions without existing PR", () => {
      const agent = makeAgent({ sandbox: "writable" });
      const result = buildGitStrategyInstructions("pr", agent, "feat/auth", "main", "origin");
      expect(result).toContain("feat/auth");
      expect(result).toContain("git push -u origin feat/auth");
      expect(result).toContain("Create a PR against");
      expect(result).toContain("PR_URL:");
    });

    it("returns PR update instructions with existing PR", () => {
      const agent = makeAgent({ sandbox: "writable" });
      const result = buildGitStrategyInstructions("pr", agent, "feat/auth", "main", "origin", {
        prNumber: 123,
      });
      expect(result).toContain("PR exists: #123");
      expect(result).toContain("push your changes");
      expect(result).toContain("gh pr comment 123");
    });
  });
});

// ─── buildReportingInstructions ─────────────────────────

describe("buildReportingInstructions", () => {
  it("includes progress reporting section", () => {
    const result = buildReportingInstructions("run-123");
    expect(result).toContain("## Reporting & Memory");
    expect(result).toContain("Progress reporting");
    expect(result).toContain("neo log milestone");
    expect(result).toContain("neo log blocker");
    expect(result).toContain("neo log action");
    expect(result).toContain("neo log decision");
  });

  it("includes memory write instructions", () => {
    const result = buildReportingInstructions("run-123");
    expect(result).toContain("Memory (persistent");
    expect(result).toContain("neo memory write --type fact");
    expect(result).toContain("neo memory write --type procedure");
    expect(result).toContain("$NEO_REPOSITORY");
  });
});

// ─── buildFullPrompt ────────────────────────────────────

describe("buildFullPrompt", () => {
  it("includes task prompt as the last section", () => {
    const result = buildFullPrompt(undefined, undefined, null, "Fix the bug");
    expect(result).toContain("## Task\n\nFix the bug");
    expect(result.endsWith("Fix the bug")).toBe(true);
  });

  it("includes agent prompt when provided", () => {
    const result = buildFullPrompt("You are a developer.", undefined, null, "Fix the bug");
    expect(result).toContain("You are a developer.");
  });

  it("includes repo instructions when provided", () => {
    const result = buildFullPrompt(undefined, "Use TypeScript strict mode.", null, "Fix the bug");
    expect(result).toContain("## Repository instructions");
    expect(result).toContain("Use TypeScript strict mode.");
  });

  it("includes git instructions when provided", () => {
    const result = buildFullPrompt(
      undefined,
      undefined,
      "## Git workflow\n\nYou are on branch `feat/test`.",
      "Fix the bug",
    );
    expect(result).toContain("## Git workflow");
    expect(result).toContain("feat/test");
  });

  it("includes memory context when provided", () => {
    const result = buildFullPrompt(
      undefined,
      undefined,
      null,
      "Fix the bug",
      "## Known context\n\nUses Prisma ORM.",
    );
    expect(result).toContain("## Known context");
    expect(result).toContain("Uses Prisma ORM");
  });

  it("includes cwd instructions when provided", () => {
    const result = buildFullPrompt(
      undefined,
      undefined,
      null,
      "Fix the bug",
      undefined,
      "## Working directory\n\nYou are in /tmp/session.",
    );
    expect(result).toContain("## Working directory");
    expect(result).toContain("/tmp/session");
  });

  it("includes reporting instructions when provided", () => {
    const reportingInstructions = buildReportingInstructions("run-123");
    const result = buildFullPrompt(
      undefined,
      undefined,
      null,
      "Fix the bug",
      undefined,
      undefined,
      reportingInstructions,
    );
    expect(result).toContain("## Reporting & Memory");
    expect(result).toContain("neo log");
  });

  it("joins sections with separator", () => {
    const result = buildFullPrompt(
      "Agent prompt.",
      "Repo instructions.",
      "Git instructions.",
      "Task prompt.",
    );
    const separatorCount = (result.match(/\n\n---\n\n/g) ?? []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(3);
  });

  it("assembles full prompt in correct order", () => {
    const result = buildFullPrompt(
      "1. Agent",
      "3. Repo",
      "4. Git",
      "6. Task",
      "2. Memory",
      "1.5. CWD",
      "5. Reporting",
    );

    const agentIndex = result.indexOf("1. Agent");
    const cwdIndex = result.indexOf("1.5. CWD");
    const memoryIndex = result.indexOf("2. Memory");
    const repoIndex = result.indexOf("3. Repo");
    const gitIndex = result.indexOf("4. Git");
    const reportingIndex = result.indexOf("5. Reporting");
    const taskIndex = result.indexOf("6. Task");

    expect(agentIndex).toBeLessThan(cwdIndex);
    expect(cwdIndex).toBeLessThan(memoryIndex);
    expect(memoryIndex).toBeLessThan(repoIndex);
    expect(repoIndex).toBeLessThan(gitIndex);
    expect(gitIndex).toBeLessThan(reportingIndex);
    expect(reportingIndex).toBeLessThan(taskIndex);
  });
});
