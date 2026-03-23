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
extends: developer
promptAppend: "Extra instructions."
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "full-agent.yml"));
    expect(config.name).toBe("full-agent");
    expect(config.maxTurns).toBe(25);
    expect(config.sandbox).toBe("writable");
    expect(config.extends).toBe("developer");
    expect(config.promptAppend).toBe("Extra instructions.");
  });

  it("loads agent with only required fields", async () => {
    await writeYaml(
      BUILT_IN_DIR,
      "minimal-agent",
      `
name: minimal-agent
extends: developer
`,
    );

    const config = await loadAgentFile(path.join(BUILT_IN_DIR, "minimal-agent.yml"));
    expect(config.name).toBe("minimal-agent");
    expect(config.extends).toBe("developer");
  });
});

// ─── resolveAgent ────────────────────────────────────────

describe("resolveAgent", () => {
  const builtIns = new Map<string, AgentConfig>();

  beforeEach(() => {
    builtIns.clear();
    builtIns.set("developer", {
      name: "developer",
      description: "Implementation worker",
      model: "opus",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      prompt: "You are a developer.",
      sandbox: "writable",
      maxTurns: 30,
    });
    builtIns.set("architect", {
      name: "architect",
      description: "Strategic planner",
      model: "opus",
      tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
      prompt: "You are an architect.",
      sandbox: "readonly",
    });
  });

  it("resolves a full custom agent (no extends)", () => {
    const config: AgentConfig = {
      name: "db-migrator",
      description: "Database migration specialist",
      model: "opus",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      prompt: "You handle DB migrations.",
      sandbox: "writable",
      maxTurns: 20,
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.name).toBe("db-migrator");
    expect(resolved.source).toBe("custom");
    expect(resolved.definition.description).toBe("Database migration specialist");
    expect(resolved.definition.model).toBe("opus");
    expect(resolved.definition.tools).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
    expect(resolved.sandbox).toBe("writable");
    expect(resolved.maxTurns).toBe(20);
  });

  it("extends a built-in: override model only", () => {
    const config: AgentConfig = {
      name: "my-dev",
      extends: "developer",
      model: "sonnet",
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.name).toBe("my-dev");
    expect(resolved.source).toBe("extended");
    expect(resolved.definition.model).toBe("sonnet");
    expect(resolved.definition.description).toBe("Implementation worker");
    expect(resolved.definition.prompt).toBe("You are a developer.");
    expect(resolved.definition.tools).toEqual(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
    expect(resolved.sandbox).toBe("writable");
    expect(resolved.maxTurns).toBe(30);
  });

  it("extends with $inherited tools + new tool", () => {
    const config: AgentConfig = {
      name: "dev-plus",
      extends: "developer",
      tools: ["$inherited", "WebSearch"],
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.tools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "WebSearch",
    ]);
  });

  it("extends with full tool replacement", () => {
    const config: AgentConfig = {
      name: "minimal-dev",
      extends: "developer",
      tools: ["Read", "Write"],
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.tools).toEqual(["Read", "Write"]);
  });

  it("extends with promptAppend", () => {
    const config: AgentConfig = {
      name: "dev-extra",
      extends: "developer",
      promptAppend: "Always use Vitest.",
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.prompt).toBe("You are a developer.\n\nAlways use Vitest.");
  });

  it("extends with prompt replacement", () => {
    const config: AgentConfig = {
      name: "dev-new",
      extends: "developer",
      prompt: "You are a new developer.",
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.prompt).toBe("You are a new developer.");
  });

  it("implicit extends: same name as built-in without extends field", () => {
    const config: AgentConfig = {
      name: "developer",
      model: "sonnet",
      maxTurns: 50,
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.source).toBe("built-in");
    expect(resolved.definition.model).toBe("sonnet");
    expect(resolved.definition.description).toBe("Implementation worker");
    expect(resolved.maxTurns).toBe(50);
  });

  it("throws for extending non-existent built-in", () => {
    const config: AgentConfig = {
      name: "bad",
      extends: "nonexistent",
    };

    expect(() => resolveAgent(config, builtIns)).toThrow("no built-in agent with that name");
  });

  it("throws for custom agent missing required fields", () => {
    const config: AgentConfig = {
      name: "incomplete",
    };

    expect(() => resolveAgent(config, builtIns)).toThrow("description");
  });

  it("inherits maxTurns from built-in when not overridden", () => {
    builtIns.set("worker", {
      name: "worker",
      description: "Worker agent",
      model: "opus",
      tools: ["Read", "Write"],
      prompt: "You are a worker.",
      sandbox: "writable",
      maxTurns: 50,
    });

    const config: AgentConfig = {
      name: "my-worker",
      extends: "worker",
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.maxTurns).toBe(50);
  });

  it("overrides maxTurns from built-in", () => {
    builtIns.set("worker", {
      name: "worker",
      description: "Worker agent",
      model: "opus",
      tools: ["Read", "Write"],
      prompt: "You are a worker.",
      sandbox: "writable",
      maxTurns: 50,
    });

    const config: AgentConfig = {
      name: "my-worker",
      extends: "worker",
      maxTurns: 10,
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.maxTurns).toBe(10);
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

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.mcpServers).toEqual(["notion", "github"]);
  });

  it("merges mcpServers from base and override when extending", () => {
    builtIns.set("mcp-base", {
      name: "mcp-base",
      description: "Base with MCP",
      model: "opus",
      tools: ["Read"],
      prompt: "Base prompt.",
      sandbox: "readonly",
      mcpServers: ["notion"],
    });

    const config: AgentConfig = {
      name: "mcp-extended",
      extends: "mcp-base",
      mcpServers: ["github"],
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.mcpServers).toEqual(["notion", "github"]);
  });

  it("deduplicates mcpServers when merging", () => {
    builtIns.set("mcp-base2", {
      name: "mcp-base2",
      description: "Base",
      model: "opus",
      tools: ["Read"],
      prompt: "Base.",
      sandbox: "readonly",
      mcpServers: ["notion", "github"],
    });

    const config: AgentConfig = {
      name: "mcp-dup",
      extends: "mcp-base2",
      mcpServers: ["notion", "slack"],
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.mcpServers).toEqual(["notion", "github", "slack"]);
  });

  it("omits mcpServers from definition when none defined", () => {
    const config: AgentConfig = {
      name: "no-mcp",
      extends: "developer",
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.mcpServers).toBeUndefined();
  });

  it("filters $inherited from tools when no extends", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone agent",
      model: "opus",
      tools: ["$inherited", "Read"],
      prompt: "You are standalone.",
      sandbox: "readonly",
    };

    const resolved = resolveAgent(config, builtIns);
    expect(resolved.definition.tools).toEqual(["Read"]);
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

  it("custom agents extend built-ins", async () => {
    await setupBuiltIns();

    await writeYaml(
      CUSTOM_DIR,
      "developer",
      `
name: developer
extends: developer
model: sonnet
tools:
  - $inherited
  - WebSearch
`,
    );

    const registry = new AgentRegistry(BUILT_IN_DIR, CUSTOM_DIR);
    await registry.load();

    const dev = registry.get("developer");
    expect(dev).toBeDefined();
    expect(dev?.source).toBe("extended");
    expect(dev?.definition.model).toBe("sonnet");
    expect(dev?.definition.tools).toContain("WebSearch");
    expect(dev?.definition.tools).toContain("Read");
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
    expect(arch?.sandbox).toBe("readonly");
  });
});
