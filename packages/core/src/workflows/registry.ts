import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { WorkflowDefinition } from "@/types";
import { loadWorkflow } from "@/workflows/loader";

/**
 * Registry for workflow definitions.
 * Loads built-in workflows from a directory and optional custom workflows.
 * Custom workflows with the same name override built-in ones.
 */
export class WorkflowRegistry {
  private readonly builtInDir: string;
  private readonly customDir: string | undefined;
  private readonly workflows = new Map<string, WorkflowDefinition>();

  constructor(builtInDir: string, customDir?: string) {
    this.builtInDir = builtInDir;
    this.customDir = customDir;
  }

  async load(): Promise<void> {
    // Load built-in workflows first
    await this.loadFromDir(this.builtInDir);

    // Custom workflows override built-in ones
    if (this.customDir) {
      await this.loadFromDir(this.customDir);
    }
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  list(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }

  has(name: string): boolean {
    return this.workflows.has(name);
  }

  private async loadFromDir(dir: string): Promise<void> {
    if (!existsSync(dir)) return;

    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const filePath = path.join(dir, file);
      const workflow = await loadWorkflow(filePath);
      this.workflows.set(workflow.name, workflow);
    }
  }
}
