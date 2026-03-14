import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflow } from "@/workflows/loader";
import { WorkflowRegistry } from "@/workflows/registry";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_workflows_test__");
const BUILTIN_DIR = path.join(TMP_DIR, "built-in");
const CUSTOM_DIR = path.join(TMP_DIR, "custom");

const VALID_WORKFLOW = `
name: hotfix
description: "Fast-track single-agent implementation"
steps:
  implement:
    agent: developer
`;

const FEATURE_WORKFLOW = `
name: feature
description: "Plan, implement, and review a feature"
steps:
  plan:
    agent: architect
    sandbox: readonly
  implement:
    agent: developer
    dependsOn: [plan]
    prompt: "Implement based on plan"
  review:
    agent: reviewer-quality
    dependsOn: [implement]
    sandbox: readonly
  fix:
    agent: fixer
    dependsOn: [review]
    condition: "output(review).hasIssues == true"
`;

const GATE_WORKFLOW = `
name: gated
description: "Workflow with a gate"
steps:
  implement:
    agent: developer
  approval:
    type: gate
    dependsOn: [implement]
    description: "Approve before deploy"
    timeout: "1h"
    autoApprove: false
`;

beforeEach(async () => {
  await mkdir(BUILTIN_DIR, { recursive: true });
  await mkdir(CUSTOM_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ─── loadWorkflow ────────────────────────────────────────

describe("loadWorkflow", () => {
  it("loads valid workflow YAML", async () => {
    const file = path.join(TMP_DIR, "hotfix.yml");
    await writeFile(file, VALID_WORKFLOW, "utf-8");

    const workflow = await loadWorkflow(file);

    expect(workflow.name).toBe("hotfix");
    expect(workflow.description).toBe("Fast-track single-agent implementation");
    expect(workflow.steps.implement).toBeDefined();
    expect((workflow.steps.implement as { agent: string }).agent).toBe("developer");
  });

  it("loads workflow with dependencies, conditions, and prompts", async () => {
    const file = path.join(TMP_DIR, "feature.yml");
    await writeFile(file, FEATURE_WORKFLOW, "utf-8");

    const workflow = await loadWorkflow(file);

    expect(workflow.name).toBe("feature");
    expect(Object.keys(workflow.steps)).toHaveLength(4);

    const implement = workflow.steps.implement as { dependsOn?: string[]; prompt?: string };
    expect(implement.dependsOn).toEqual(["plan"]);
    expect(implement.prompt).toBe("Implement based on plan");
  });

  it("parses gate step type", async () => {
    const file = path.join(TMP_DIR, "gated.yml");
    await writeFile(file, GATE_WORKFLOW, "utf-8");

    const workflow = await loadWorkflow(file);

    const approval = workflow.steps.approval as { type: string; description: string };
    expect(approval.type).toBe("gate");
    expect(approval.description).toBe("Approve before deploy");
  });

  it("rejects invalid YAML with descriptive error", async () => {
    const file = path.join(TMP_DIR, "invalid.yml");
    await writeFile(file, "name: test\n", "utf-8");

    await expect(loadWorkflow(file)).rejects.toThrow("Invalid workflow definition");
  });

  it("rejects workflow with no steps", async () => {
    const file = path.join(TMP_DIR, "empty.yml");
    await writeFile(file, "name: empty\nsteps: {}\n", "utf-8");

    await expect(loadWorkflow(file)).rejects.toThrow("at least one step");
  });
});

// ─── WorkflowRegistry ────────────────────────────────────

describe("WorkflowRegistry", () => {
  it("loads built-in workflows", async () => {
    await writeFile(path.join(BUILTIN_DIR, "hotfix.yml"), VALID_WORKFLOW, "utf-8");
    await writeFile(path.join(BUILTIN_DIR, "feature.yml"), FEATURE_WORKFLOW, "utf-8");

    const registry = new WorkflowRegistry(BUILTIN_DIR);
    await registry.load();

    expect(registry.list()).toHaveLength(2);
    expect(registry.has("hotfix")).toBe(true);
    expect(registry.has("feature")).toBe(true);
  });

  it("get() returns workflow by name", async () => {
    await writeFile(path.join(BUILTIN_DIR, "hotfix.yml"), VALID_WORKFLOW, "utf-8");

    const registry = new WorkflowRegistry(BUILTIN_DIR);
    await registry.load();

    const workflow = registry.get("hotfix");
    expect(workflow).toBeDefined();
    expect(workflow?.name).toBe("hotfix");
  });

  it("get() returns undefined for unknown workflow", async () => {
    const registry = new WorkflowRegistry(BUILTIN_DIR);
    await registry.load();

    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has() returns false for unknown workflow", async () => {
    const registry = new WorkflowRegistry(BUILTIN_DIR);
    await registry.load();

    expect(registry.has("nonexistent")).toBe(false);
  });

  it("custom workflows override built-in", async () => {
    await writeFile(path.join(BUILTIN_DIR, "hotfix.yml"), VALID_WORKFLOW, "utf-8");

    const customHotfix = `
name: hotfix
description: "Custom hotfix"
steps:
  implement:
    agent: custom-developer
`;
    await writeFile(path.join(CUSTOM_DIR, "hotfix.yml"), customHotfix, "utf-8");

    const registry = new WorkflowRegistry(BUILTIN_DIR, CUSTOM_DIR);
    await registry.load();

    const workflow = registry.get("hotfix");
    expect(workflow?.description).toBe("Custom hotfix");
    expect((workflow?.steps.implement as { agent: string }).agent).toBe("custom-developer");
  });

  it("handles non-existent directory gracefully", async () => {
    const registry = new WorkflowRegistry("/nonexistent/path");
    await registry.load();

    expect(registry.list()).toHaveLength(0);
  });

  it("ignores non-YAML files", async () => {
    await writeFile(path.join(BUILTIN_DIR, "hotfix.yml"), VALID_WORKFLOW, "utf-8");
    await writeFile(path.join(BUILTIN_DIR, "README.md"), "# Workflows", "utf-8");

    const registry = new WorkflowRegistry(BUILTIN_DIR);
    await registry.load();

    expect(registry.list()).toHaveLength(1);
  });
});
