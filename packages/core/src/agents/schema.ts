import { z } from "zod";

// ─── Agent model enum ────────────────────────────────────

export const agentModelSchema = z.enum(["opus", "sonnet", "haiku"]);

// ─── Agent tool enum ─────────────────────────────────────

export const agentToolSchema = z.enum([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "Agent",
  "WebSearch",
  "WebFetch",
  "NotebookEdit",
]);

// ─── Agent tool entry (tool or $inherited token) ─────────

export const agentToolEntrySchema = z.union([agentToolSchema, z.literal("$inherited")]);

// ─── Agent sandbox enum ──────────────────────────────────

export const agentSandboxSchema = z.enum(["writable", "readonly"]);

// ─── AgentConfig schema (from YAML) ─────────────────────

export const agentConfigSchema = z.object({
  name: z.string(),
  extends: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  model: agentModelSchema.optional(),
  tools: z.array(agentToolEntrySchema).optional(),
  prompt: z.string().optional(),
  promptAppend: z.string().optional(),
  sandbox: agentSandboxSchema.optional(),
  maxTurns: z.number().optional(),
  mcpServers: z.array(z.string()).optional(),
});

// ─── Derived types ───────────────────────────────────────

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentModel = z.infer<typeof agentModelSchema>;
export type AgentTool = z.infer<typeof agentToolSchema>;
export type AgentToolEntry = z.infer<typeof agentToolEntrySchema>;
