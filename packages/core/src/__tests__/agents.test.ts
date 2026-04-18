import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentFile } from "@/agents/loader";
import { AgentRegistry } from "@/agents/registry";
import { resolveAgent } from "@/agents/resolver";
import type { AgentConfig } from "@/agents/schema";
import { validateAgentModels } from "@/agents/validation";
import type { ResolvedAgent } from "@/types";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_agents_test__");
const BUILT_IN_DIR = path.join(TMP_DIR, "built-in");
const CUSTOM_DIR = path.join(TMP_DIR, "custom");
const PROMPTS_DIR = path.join(TMP_DIR, "prompts");

beforeEach(async () => {
  await mkdir(BUILT_IN_DIR, { recursive: true });
  await mkdir(CUSTOM_DIR, { recursive: true });
  await mkdir(PROMPTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function writeYaml(dir: string, name: string, content: string): Promise<void> {
  return writeFile(path.join(dir, `${name}.yml`), content, "utf-8");
}

function writePrompt(name: string, content: string): Promise<void> {
  return writeFile(path.join(PROMPTS_DIR, `${name}.md`), content, "utf-8");
}

// ─── loadAgentFile ───────────────────────────────────────

describe("loadAgentFile", () => {
  it("loads a valid agent YAML file", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "developer",
      `
name: developer
description: "Implementation worker"
sandbox: writable
prompt: "You are a developer agent."
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "developer.yml"));
    expect(config.name).toBe("developer");
    expect(config.sandbox).toBe("writable");
  });

  it("resolves prompt from .md file", async () => {
    await writePrompt("my-agent", "# My Agent\n\nYou do things.");
    await writeYaml(
      BUILT_IN_DIR,
      "my-agent",
      `
name: my-agent
description: "Test agent"
sandbox: readonly
prompt: ${path.join(PROMPTS_DIR, "my-agent.md")}
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "my-agent.yml"));
    expect(config.prompt).toBe("# My Agent\n\nYou do things.");
  });

  it("resolves prompt relative to YAML file directory", async () => {
    const agentDir = path.join(TMP_DIR, "agents-with-prompts");
    const promptDir = path.join(TMP_DIR, "agents-with-prompts", "prompts");
    await mkdir(promptDir, { recursive: true });

    await writeFile(path.join(promptDir, "test.md"), "Test prompt content", "utf-8");
    await writeFile(
      path.join(agentDir, "test.yml"),
      `
name: test
description: "Test"
sandbox: readonly
prompt: prompts/test.md
`,
      "utf-8",
    );

    const config = await loadAgentFile(path.join(agentDir, "test.yml"));
    expect(config.prompt).toBe("Test prompt content");
  });

  it("throws for missing prompt file", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "bad",
      `
name: bad
description: "Bad agent"
sandbox: readonly
prompt: nonexistent.md
`,
    );

    await expect(loadAgentFile(path.join(BUILT_IN_DIR, "bad.yml"))).rejects.toThrow(
      "Prompt file not found",
    );
  });

  it("throws for invalid schema (missing required fields)", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "invalid",
      `
name: invalid
`,
    );

    await expect(loadAgentFile(path.join(BUILT_IN_DIR, "invalid.yml"))).rejects.toThrow(
      "Invalid agent config",
    );
  });

  it("loads agent with all optional fields", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "full-agent",
      `
name: full-agent
description: "Full featured agent"
model: claude-opus-4-6
sandbox: writable
prompt: "You are a full agent."
maxTurns: 25
promptAppend: "Extra instructions."
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "full-agent.yml"));
    expect(config.name).toBe("full-agent");
    expect(config.maxTurns).toBe(25);
    expect(config.sandbox).toBe("writable");
    expect(config.promptAppend).toBe("Extra instructions.");
  });

  it("loads agent with minimal required fields", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "minimal-agent",
      `
name: minimal-agent
description: "Minimal agent"
sandbox: readonly
prompt: "You are a minimal agent."
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "minimal-agent.yml"));
    expect(config.name).toBe("minimal-agent");
    expect(config.description).toBe("Minimal agent");
  });

  it("accepts free-string model field", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "model-agent",
      `
name: model-agent
description: "Agent with model"
model: claude-opus-4-6
sandbox: readonly
prompt: "You are an agent."
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "model-agent.yml"));
    expect(config.model).toBe("claude-opus-4-6");
  });

  // ─── maxCost schema validation tests ─────────────────────

  it("loads agent with maxCost field", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "budget-agent",
      `
name: budget-agent
description: "Agent with budget"
sandbox: writable
prompt: "You are a budget-limited agent."
maxCost: 5.0
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "budget-agent.yml"));
    expect(config.name).toBe("budget-agent");
    expect(config.maxCost).toBe(5.0);
  });

  it("accepts maxCost of zero", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "zero-budget",
      `
name: zero-budget
description: "Agent with zero budget"
sandbox: readonly
prompt: "You are a zero-budget agent."
maxCost: 0
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "zero-budget.yml"));
    expect(config.maxCost).toBe(0);
  });

  it("rejects negative maxCost", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "negative-budget",
      `
name: negative-budget
description: "Agent with negative budget"
sandbox: readonly
prompt: "You are an invalid agent."
maxCost: -1.0
`,
    );

    await expect(loadAgentFile(path.join(BUILT_IN_DIR, "negative-budget.yml"))).rejects.toThrow(
      "Invalid agent config",
    );
  });
});

// ─── resolveAgent ────────────────────────────────────────

describe("resolveAgent", () => {
  it("resolves a complete agent config", () => {
    const config: AgentConfig = {
      name: "db-migrator",
      description: "Database migration specialist",
      model: "claude-opus-4-6",
      prompt: "You handle DB migrations.",
      sandbox: "writable",
      maxTurns: 20,
    };

    const resolved = resolveAgent(config);
    expect(resolved.name).toBe("db-migrator");
    expect(resolved.source).toBe("custom");
    expect(resolved.definition.description).toBe("Database migration specialist");
    expect(resolved.definition.model).toBe("claude-opus-4-6");
    expect(resolved.sandbox).toBe("writable");
    expect(resolved.maxTurns).toBe(20);
  });

  it("applies promptAppend to prompt", () => {
    const config: AgentConfig = {
      name: "dev-extra",
      description: "Developer",
      model: "claude-opus-4-6",
      prompt: "You are a developer.",
      promptAppend: "Always use Vitest.",
      sandbox: "writable",
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.prompt).toBe("You are a developer.\n\nAlways use Vitest.");
  });

  it("carries mcpServers from agent config into definition", () => {
    const config: AgentConfig = {
      name: "dev-notion",
      description: "Dev with MCP",
      model: "claude-opus-4-6",
      prompt: "You are a dev with Notion.",
      sandbox: "writable",
      mcpServers: ["notion", "github"],
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.mcpServers).toEqual(["notion", "github"]);
  });

  it("omits mcpServers from definition when none defined", () => {
    const config: AgentConfig = {
      name: "no-mcp",
      description: "Developer",
      model: "claude-opus-4-6",
      prompt: "You are a developer.",
      sandbox: "writable",
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.mcpServers).toBeUndefined();
  });

  it("parses version field when present", () => {
    const config: AgentConfig = {
      name: "versioned-agent",
      description: "Agent with version",
      model: "claude-opus-4-6",
      prompt: "You are a versioned agent.",
      sandbox: "writable",
      version: "1.2.3",
    };

    const resolved = resolveAgent(config);
    expect(resolved.version).toBe("1.2.3");
  });

  it("allows version field to be optional", () => {
    const config: AgentConfig = {
      name: "no-version-agent",
      description: "Agent without version",
      model: "claude-opus-4-6",
      prompt: "You are an agent without version.",
      sandbox: "readonly",
    };

    const resolved = resolveAgent(config);
    expect(resolved.version).toBeUndefined();
  });

  it("parses maxCost field when present", () => {
    const config: AgentConfig = {
      name: "budget-agent",
      description: "Agent with budget",
      model: "claude-opus-4-6",
      prompt: "You are a budget-limited agent.",
      sandbox: "writable",
      maxCost: 5.0,
    };

    const resolved = resolveAgent(config);
    expect(resolved.maxCost).toBe(5.0);
  });

  it("allows maxCost field to be optional", () => {
    const config: AgentConfig = {
      name: "no-budget-agent",
      description: "Agent without budget",
      model: "claude-opus-4-6",
      prompt: "You are an agent without budget limit.",
      sandbox: "readonly",
    };

    const resolved = resolveAgent(config);
    expect(resolved.maxCost).toBeUndefined();
  });

  it("resolves agent without model (uses provider default)", () => {
    const config: AgentConfig = {
      name: "no-model-agent",
      description: "Agent without explicit model",
      prompt: "You are an agent.",
      sandbox: "readonly",
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.model).toBeUndefined();
  });
});

// ─── AgentRegistry ───────────────────────────────────────

describe("AgentRegistry", () => {
  async function setupBuiltIns(): Promise<void> {
    await writePrompt("dev", "You are a developer.");
    await writePrompt("arch", "You are an architect.");

    await writeYaml(
      BUILT_IN_DIR,
      "developer",
      `
name: developer
description: "Implementation worker"
sandbox: writable
prompt: ${path.join(PROMPTS_DIR, "dev.md")}
maxTurns: 30
`,
    );

    await writeYaml(
      BUILT_IN_DIR,
      "architect",
      `
name: architect
description: "Strategic planner"
sandbox: readonly
prompt: ${path.join(PROMPTS_DIR, "arch.md")}
`,
    );
  }

  it("loads built-in agents", async () => {
    await setupBuiltIns();

    const registry = new AgentRegistry(BUILT_IN_DIR);
    await registry.load();

    expect(registry.list()).toHaveLength(2);
    expect(registry.has("developer")).toBe(true);
    expect(registry.has("architect")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("get() returns the correct agent", async () => {
    await setupBuiltIns();

    const registry = new AgentRegistry(BUILT_IN_DIR);
    await registry.load();

    const dev = registry.get("developer");
    expect(dev).toBeDefined();
    expect(dev?.name).toBe("developer");
    expect(dev?.source).toBe("built-in");
  });

  it("get() returns undefined for unknown agent", async () => {
    await setupBuiltIns();

    const registry = new AgentRegistry(BUILT_IN_DIR);
    await registry.load();

    expect(registry.get("unknown")).toBeUndefined();
  });

  it("custom agents add new agents", async () => {
    await setupBuiltIns();
    await writePrompt("qa", "You are QA.");

    await writeYaml(
      CUSTOM_DIR,
      "qa-tester",
      `
name: qa-tester
description: "QA specialist"
sandbox: writable
prompt: ${path.join(PROMPTS_DIR, "qa.md")}
`,
    );

    const registry = new AgentRegistry(BUILT_IN_DIR, CUSTOM_DIR);
    await registry.load();

    expect(registry.has("qa-tester")).toBe(true);
    const qa = registry.get("qa-tester");
    expect(qa?.source).toBe("custom");
  });

  it("handles missing custom dir gracefully", async () => {
    await setupBuiltIns();

    const registry = new AgentRegistry(BUILT_IN_DIR, "/nonexistent/custom/dir");
    await registry.load();

    expect(registry.list()).toHaveLength(2);
  });

  it("loads real built-in agents from packages/agents", async () => {
    const realBuiltInDir = path.resolve(import.meta.dirname, "../../../agents/agents");
    const registry = new AgentRegistry(realBuiltInDir);
    await registry.load();

    expect(registry.list().length).toBe(7);
    expect(registry.has("architect")).toBe(true);
    expect(registry.has("developer")).toBe(true);
    expect(registry.has("reviewer")).toBe(true);
    expect(registry.has("scout")).toBe(true);
    expect(registry.has("spec-reviewer")).toBe(true);
    expect(registry.has("code-quality-reviewer")).toBe(true);
    expect(registry.has("plan-reviewer")).toBe(true);

    const arch = registry.get("architect");
    expect(arch).toBeDefined();
    expect(arch?.definition.description).toBeTruthy();
    expect(arch?.definition.prompt).toBeTruthy();
    expect(arch?.sandbox).toBe("writable");
  });
});

// ─── validateAgentModels ─────────────────────────────────

describe("validateAgentModels", () => {
  it("passes for agents with valid models", () => {
    const agents: ResolvedAgent[] = [
      {
        name: "dev",
        definition: { description: "Dev", prompt: "test", model: "claude-opus-4-6" },
        sandbox: "writable",
        source: "built-in",
      },
    ];
    expect(() => validateAgentModels(agents)).not.toThrow();
  });

  it("passes for agents without model (uses default)", () => {
    const agents: ResolvedAgent[] = [
      {
        name: "dev",
        definition: { description: "Dev", prompt: "test" },
        sandbox: "writable",
        source: "built-in",
      },
    ];
    expect(() => validateAgentModels(agents)).not.toThrow();
  });

  it("throws for agent with unsupported model", () => {
    const agents: ResolvedAgent[] = [
      {
        name: "dev",
        definition: { description: "Dev", prompt: "test", model: "gpt-4o" },
        sandbox: "writable",
        source: "built-in",
      },
    ];
    expect(() => validateAgentModels(agents)).toThrow('Agent "dev" specifies model "gpt-4o"');
  });
});
