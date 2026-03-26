import { z } from "zod";

// ─── Memory types ────────────────────────────────────────

export const memoryTypeSchema = z.enum([
  "knowledge", // replaces fact + procedure
  "warning", // replaces feedback, always injected
  "focus", // unchanged, ephemeral working memory
]);

export type MemoryType = z.infer<typeof memoryTypeSchema>;

// ─── Subtype for knowledge entries ───────────────────────

export const knowledgeSubtypeSchema = z.enum(["fact", "procedure"]);

export type KnowledgeSubtype = z.infer<typeof knowledgeSubtypeSchema>;

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
  outcome: z.string().optional(), // legacy, kept for task migration
  runId: z.string().optional(),
  category: z.string().optional(), // warning: category
  severity: z.string().optional(),
  subtype: z.string().optional(), // knowledge: "fact" | "procedure"
  // supersedes removed — dead code
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
  subtype: z.string().optional(), // "fact" | "procedure" for knowledge type
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

// ─── Search result (extends MemoryEntry with score) ─────

export interface SearchResult extends MemoryEntry {
  /** Relevance score from 0 to 1, where 1 is most relevant */
  score: number;
}
