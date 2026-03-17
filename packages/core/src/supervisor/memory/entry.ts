import { z } from "zod";

// ─── Memory types ────────────────────────────────────────

export const memoryTypeSchema = z.enum([
  "fact",
  "procedure",
  "episode",
  "focus",
  "feedback",
  "task",
]);

export type MemoryType = z.infer<typeof memoryTypeSchema>;

// ─── Memory entry (persisted in SQLite) ──────────────────

export const memoryEntrySchema = z.object({
  id: z.string(),
  type: memoryTypeSchema,
  scope: z.string(), // "global" | repo path
  content: z.string(),
  source: z.string(), // "developer" | "reviewer" | "supervisor" | "user"
  tags: z.array(z.string()).default([]),

  // Lifecycle
  createdAt: z.string(),
  lastAccessedAt: z.string(),
  accessCount: z.number().default(0),

  // Optional per-type fields
  expiresAt: z.string().optional(), // focus TTL
  outcome: z.string().optional(), // episode: success/failure/blocked
  runId: z.string().optional(),
  category: z.string().optional(), // feedback: reviewer issue category
  severity: z.string().optional(),
  supersedes: z.string().optional(), // contradiction resolution
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

// ─── Write input (id and timestamps are auto-generated) ──

export const memoryWriteInputSchema = z.object({
  type: memoryTypeSchema,
  scope: z.string().default("global"),
  content: z.string(),
  source: z.string().default("user"),
  tags: z.array(z.string()).default([]),
  expiresAt: z.string().optional(),
  outcome: z.string().optional(),
  runId: z.string().optional(),
  category: z.string().optional(),
  severity: z.string().optional(),
  supersedes: z.string().optional(),
});

export type MemoryWriteInput = z.input<typeof memoryWriteInputSchema>;

// ─── Query options ───────────────────────────────────────

export interface MemoryQuery {
  scope?: string;
  types?: MemoryType[];
  since?: string; // ISO timestamp
  limit?: number;
  sortBy?: "relevance" | "createdAt" | "accessCount";
  tags?: string[];
}

// ─── Stats ───────────────────────────────────────────────

export interface MemoryStats {
  total: number;
  byType: Record<string, number>;
  byScope: Record<string, number>;
}
