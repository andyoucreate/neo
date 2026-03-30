import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentFile } from "@/agents/loader";
import { AgentRegistry } from "@/agents/registry";
import { resolveAgent } from "@/agents/resolver";
import type { AgentConfig } from "@/agents/schema";

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
model: opus
tools: [Read, Write, Edit, Bash, Glob, Grep]
sandbox: writable
prompt: "You are a developer agent."
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "developer.yml"));
    expect(config.name).toBe("developer");
    expect(config.model).toBe("opus");
    expect(config.tools).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
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
model: sonnet
tools: [Read]
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
model: haiku
tools: [Read]
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
model: opus
tools: [Read]
sandbox: readonly
prompt: nonexistent.md
`,
    );

    await expect(loadAgentFile(path.join(BUILT_IN_DIR, "bad.yml"))).rejects.toThrow(
      "Prompt file not found",
    );
  });

  it("loads agent with inline subagent definitions", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "with-agents",
      `
name: with-agents
description: "Agent with subagents"
model: opus
tools: [Read, Agent]
sandbox: writable
prompt: "You are an agent."
agents:
  reviewer:
    description: "Code reviewer"
    prompt: "You review code."
    tools: [Read, Grep, Glob]
    model: sonnet
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "with-agents.yml"));
    expect(config.agents).toBeDefined();
    const reviewer = config.agents?.reviewer;
    expect(reviewer).toBeDefined();
    expect(reviewer?.description).toBe("Code reviewer");
    expect(reviewer?.prompt).toBe("You review code.");
    expect(reviewer?.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(reviewer?.model).toBe("sonnet");
  });

  it("resolves subagent .md prompt paths", async () => {
    await writeFile(path.join(PROMPTS_DIR, "review.md"), "You are a reviewer agent.", "utf-8");

    await writeYaml(
      BUILT_IN_DIR,
      "with-md-agents",
      `
name: with-md-agents
description: "Agent with md subagent"
model: opus
tools: [Read, Agent]
sandbox: writable
prompt: "You are an agent."
agents:
  reviewer:
    description: "Code reviewer"
    prompt: ../prompts/review.md
    tools: [Read]
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "with-md-agents.yml"));
    expect(config.agents?.reviewer?.prompt).toBe("You are a reviewer agent.");
  });

  it("throws for invalid schema", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "invalid",
      `
name: invalid
model: gpt-4
tools: [Read]
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
model: opus
tools: [Read, Write, Edit, Bash]
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
model: opus
tools: [Read]
sandbox: readonly
prompt: "You are a minimal agent."
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "minimal-agent.yml"));
    expect(config.name).toBe("minimal-agent");
    expect(config.description).toBe("Minimal agent");
  });

  // ─── maxCost schema validation tests ─────────────────────

  it("loads agent with maxCost field", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "budget-agent",
      `
name: budget-agent
description: "Agent with budget"
model: opus
tools: [Read, Write]
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
model: opus
tools: [Read]
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
model: opus
tools: [Read]
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
      model: "opus",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      prompt: "You handle DB migrations.",
      sandbox: "writable",
      maxTurns: 20,
    };

    const resolved = resolveAgent(config);
    expect(resolved.name).toBe("db-migrator");
    expect(resolved.source).toBe("custom");
    expect(resolved.definition.description).toBe("Database migration specialist");
    expect(resolved.definition.model).toBe("opus");
    expect(resolved.definition.tools).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
    expect(resolved.sandbox).toBe("writable");
    expect(resolved.maxTurns).toBe(20);
  });

  it("throws for agent missing description", () => {
    const config: AgentConfig = {
      name: "incomplete",
      model: "opus",
      tools: ["Read"],
      prompt: "Test",
      sandbox: "readonly",
    };

    expect(() => resolveAgent(config)).toThrow("description");
  });

  it("throws for agent missing model", () => {
    const config: AgentConfig = {
      name: "incomplete",
      description: "Test agent",
      tools: ["Read"],
      prompt: "Test",
      sandbox: "readonly",
    };

    expect(() => resolveAgent(config)).toThrow("model");
  });

  it("throws for agent missing tools", () => {
    const config: AgentConfig = {
      name: "incomplete",
      description: "Test agent",
      model: "opus",
      prompt: "Test",
      sandbox: "readonly",
    };

    expect(() => resolveAgent(config)).toThrow("tools");
  });

  it("throws for agent missing sandbox", () => {
    const config: AgentConfig = {
      name: "incomplete",
      description: "Test agent",
      model: "opus",
      tools: ["Read"],
      prompt: "Test",
    };

    expect(() => resolveAgent(config)).toThrow("sandbox");
  });

  it("throws for agent missing prompt", () => {
    const config: AgentConfig = {
      name: "incomplete",
      description: "Test agent",
      model: "opus",
      tools: ["Read"],
      sandbox: "readonly",
    };

    expect(() => resolveAgent(config)).toThrow("prompt");
  });

  it("applies promptAppend to prompt", () => {
    const config: AgentConfig = {
      name: "dev-extra",
      description: "Developer",
      model: "opus",
      tools: ["Read"],
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
      model: "opus",
      tools: ["Read", "Write"],
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
      model: "opus",
      tools: ["Read"],
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
      model: "opus",
      tools: ["Read", "Write"],
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
      model: "opus",
      tools: ["Read"],
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
      model: "opus",
      tools: ["Read", "Write"],
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
      model: "opus",
      tools: ["Read"],
      prompt: "You are an agent without budget limit.",
      sandbox: "readonly",
    };

    const resolved = resolveAgent(config);
    expect(resolved.maxCost).toBeUndefined();
  });

  it("includes agents subfield in definition", () => {
    const config: AgentConfig = {
      name: "developer",
      description: "Dev",
      model: "opus",
      tools: ["Read"],
      sandbox: "writable",
      prompt: "You are a developer.",
      agents: {
        reviewer: {
          description: "Code reviewer",
          prompt: "Review code.",
          tools: ["Read"],
        },
      },
    };

    const resolved = resolveAgent(config);
    expect(resolved.definition.agents).toEqual({
      reviewer: {
        description: "Code reviewer",
        prompt: "Review code.",
        tools: ["Read"],
      },
    });
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
model: opus
tools: [Read, Write, Edit, Bash, Glob, Grep]
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
model: opus
tools: [Read, Glob, Grep, WebSearch, WebFetch]
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
    expect(dev?.definition.model).toBe("opus");
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
model: sonnet
tools: [Read, Write, Edit, Bash, Glob, Grep]
sandbox: writable
prompt: ${path.join(PROMPTS_DIR, "qa.md")}
`,
    );

    const registry = new AgentRegistry(BUILT_IN_DIR, CUSTOM_DIR);
    await registry.load();

    expect(registry.has("qa-tester")).toBe(true);
    const qa = registry.get("qa-tester");
    expect(qa?.source).toBe("custom");
    expect(qa?.definition.model).toBe("sonnet");
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

    expect(registry.list().length).toBe(4);
    expect(registry.has("architect")).toBe(true);
    expect(registry.has("developer")).toBe(true);
    expect(registry.has("reviewer")).toBe(true);
    expect(registry.has("scout")).toBe(true);

    // Verify a resolved agent has all required fields
    const arch = registry.get("architect");
    expect(arch).toBeDefined();
    expect(arch?.definition.description).toBeTruthy();
    expect(arch?.definition.prompt).toBeTruthy();
    expect(arch?.definition.tools.length).toBeGreaterThan(0);
    expect(arch?.definition.model).toBe("opus");
    expect(arch?.sandbox).toBe("writable");
  });
});
