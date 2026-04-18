import { z } from "zod";

// ─── Agent sandbox enum ──────────────────────────────────

export const agentSandboxSchema = z.enum(["writable", "readonly"]);

// ─── AgentConfig schema (from YAML) ─────────────────────

export const agentConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  sandbox: agentSandboxSchema,
  prompt: z.string(),
  model: z.string().optional(),
  promptAppend: z.string().optional(),
  maxTurns: z.number().optional(),
  maxCost: z.number().min(0).optional(),
  mcpServers: z.array(z.string()).optional(),
  version: z.string().optional(),
});

// ─── Derived types ───────────────────────────────────────

export type AgentConfig = z.infer<typeof agentConfigSchema>;
