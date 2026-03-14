import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import type { WorkflowDefinition, WorkflowGateDef, WorkflowStepDef } from "@/types";

// ─── Zod Schemas ────────────────────────────────────────

const workflowStepDefSchema = z.object({
  type: z.literal("step").optional().default("step"),
  agent: z.string(),
  dependsOn: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  sandbox: z.enum(["writable", "readonly"]).optional(),
  maxTurns: z.number().int().positive().optional(),
  mcpServers: z.array(z.string()).optional(),
  recovery: z
    .object({
      maxRetries: z.number().int().nonnegative().optional(),
      nonRetryable: z.array(z.string()).optional(),
    })
    .optional(),
  condition: z.string().optional(),
});

const workflowGateDefSchema = z.object({
  type: z.literal("gate"),
  dependsOn: z.array(z.string()).optional(),
  description: z.string(),
  timeout: z.string().optional(),
  autoApprove: z.boolean().optional(),
});

const workflowHeaderSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.record(z.string(), z.unknown()),
});

// ─── Helpers ────────────────────────────────────────────

function parseStepEntry(
  stepName: string,
  stepValue: unknown,
): { step: WorkflowStepDef | WorkflowGateDef; errors: string[] } {
  const obj = stepValue as Record<string, unknown>;
  const schema = obj.type === "gate" ? workflowGateDefSchema : workflowStepDefSchema;
  const result = schema.safeParse(stepValue);

  if (result.success) {
    return { step: result.data as WorkflowStepDef | WorkflowGateDef, errors: [] };
  }
  return {
    step: stepValue as WorkflowStepDef,
    errors: result.error.issues.map(
      (i) => `  - steps.${stepName}.${i.path.join(".")}: ${i.message}`,
    ),
  };
}

function parseSteps(
  rawSteps: Record<string, unknown>,
  filePath: string,
): Record<string, WorkflowStepDef | WorkflowGateDef> {
  if (Object.keys(rawSteps).length === 0) {
    throw new Error(
      `Invalid workflow definition in ${filePath}:\n  - steps: Workflow must have at least one step`,
    );
  }

  const steps: Record<string, WorkflowStepDef | WorkflowGateDef> = {};
  const errors: string[] = [];

  for (const [name, value] of Object.entries(rawSteps)) {
    const { step, errors: stepErrors } = parseStepEntry(name, value);
    if (stepErrors.length > 0) {
      errors.push(...stepErrors);
    } else {
      steps[name] = step;
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid workflow definition in ${filePath}:\n${errors.join("\n")}`);
  }

  return steps;
}

// ─── Loader ─────────────────────────────────────────────

export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const content = await readFile(filePath, "utf-8");
  const raw = parse(content) as unknown;

  const headerResult = workflowHeaderSchema.safeParse(raw);
  if (!headerResult.success) {
    const issues = headerResult.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid workflow definition in ${filePath}:\n${issues}`);
  }

  const { name, description, steps: rawSteps } = headerResult.data;
  const steps = parseSteps(rawSteps, filePath);

  return { name, description, steps };
}

export { workflowGateDefSchema, workflowStepDefSchema };
