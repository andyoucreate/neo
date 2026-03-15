import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type MemoryOp, memoryOpSchema } from "./schemas.js";

const MEMORY_FILE = "memory.json";
const ARCHIVE_FILE = "memory-archive.jsonl";
const LEGACY_FILE = "memory.md";
const MAX_SIZE_KB = 6;
const MAX_DECISIONS = 10;

// ─── Structured memory type ─────────────────────────────

export interface ActiveWorkItem {
  description: string;
  runId?: string;
  repo?: string;
  status: "running" | "waiting" | "blocked";
  priority?: "critical" | "high" | "medium" | "low";
  since: string;
  deadline?: string;
}

export interface BlockerItem {
  description: string;
  source?: string;
  runId?: string;
  repo?: string;
  since: string;
}

export interface DecisionItem {
  date: string;
  decision: string;
  outcome?: string;
}

export interface SupervisorMemory {
  agenda: string;
  activeWork: ActiveWorkItem[];
  blockers: BlockerItem[];
  decisions: DecisionItem[];
  trackerSync: Record<string, string>;
}

/**
 * Parse raw memory content into structured format.
 * Tries JSON first, falls back to empty memory.
 * Handles migration from old format (string arrays).
 */
export function parseStructuredMemory(raw: string): SupervisorMemory {
  if (!raw.trim()) return emptyMemory();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Migration: detect old format
    const isOldFormat =
      Array.isArray(parsed.activeWork) &&
      parsed.activeWork.length > 0 &&
      typeof parsed.activeWork[0] === "string";

    if (isOldFormat) {
      return migrateFromOldFormat(parsed);
    }

    return {
      agenda: (parsed.agenda as string) ?? "",
      activeWork: normalizeActiveWork(parsed.activeWork),
      blockers: normalizeBlockers(parsed.blockers),
      decisions:
        (parsed.decisions as DecisionItem[]) ?? (parsed.recentDecisions as DecisionItem[]) ?? [],
      trackerSync: (parsed.trackerSync as Record<string, string>) ?? {},
    };
  } catch {
    return emptyMemory();
  }
}

/**
 * Normalize activeWork items from potentially free-form LLM output
 * into the expected ActiveWorkItem shape.
 */
function normalizeActiveWork(raw: unknown): ActiveWorkItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: unknown) => {
      if (typeof item === "string") {
        return { description: item, status: "running" as const, since: new Date().toISOString() };
      }
      if (item == null || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const result: ActiveWorkItem = {
        description:
          (obj.description as string) ?? (obj.ticket as string) ?? JSON.stringify(obj),
        status:
          validateStatus(obj.status) ??
          ((obj.stage as string) === "ci_pending" ? "waiting" : "running"),
        since: (obj.since as string) ?? new Date().toISOString(),
      };
      if (obj.runId) result.runId = obj.runId as string;
      if (obj.repo) result.repo = obj.repo as string;
      const prio = validatePriority(obj.priority);
      if (prio) result.priority = prio;
      if (obj.deadline) result.deadline = obj.deadline as string;
      return result;
    })
    .filter((item): item is ActiveWorkItem => item !== null);
}

function validateStatus(v: unknown): ActiveWorkItem["status"] | undefined {
  if (v === "running" || v === "waiting" || v === "blocked") return v;
  return undefined;
}

function validatePriority(v: unknown): ActiveWorkItem["priority"] | undefined {
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  return undefined;
}

/**
 * Normalize blocker items from potentially free-form LLM output
 * into the expected BlockerItem shape.
 */
function normalizeBlockers(raw: unknown): BlockerItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: unknown) => {
      if (typeof item === "string") {
        return { description: item, since: new Date().toISOString() };
      }
      if (item == null || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      return {
        description:
          (obj.description as string) ??
          (obj.reason as string) ??
          (obj.ticket as string) ??
          JSON.stringify(obj),
        source: (obj.source as string) ?? undefined,
        runId: (obj.runId as string) ?? undefined,
        repo: (obj.repo as string) ?? undefined,
        since: (obj.since as string) ?? new Date().toISOString(),
      } as BlockerItem;
    })
    .filter((item): item is BlockerItem => item !== null);
}

function migrateFromOldFormat(parsed: Record<string, unknown>): SupervisorMemory {
  const now = new Date().toISOString();

  const activeWork = (parsed.activeWork as string[]).map((s) => ({
    description: s,
    status: "running" as const,
    since: now,
  }));

  const blockers = Array.isArray(parsed.blockers)
    ? (parsed.blockers as string[]).map((s) => ({
        description: s,
        since: now,
      }))
    : [];

  const decisions = (parsed.recentDecisions as DecisionItem[]) ?? [];

  // Log warnings for dropped fields
  const notes = parsed.notes as string | undefined;
  if (notes?.trim()) {
  }

  const repoNotes = parsed.repoNotes as Record<string, string> | undefined;
  if (repoNotes && Object.keys(repoNotes).length > 0) {
  }

  return {
    agenda: "",
    activeWork,
    blockers,
    decisions,
    trackerSync: (parsed.trackerSync as Record<string, string>) ?? {},
  };
}

function emptyMemory(): SupervisorMemory {
  return {
    agenda: "",
    activeWork: [],
    blockers: [],
    decisions: [],
    trackerSync: {},
  };
}

// ─── Knowledge re-exports (deprecated — use knowledge.ts in Phase 3) ─

/** @deprecated Import from knowledge.ts instead. */
export { loadKnowledge, saveKnowledge } from "./knowledge.js";

// ─── Memory (working/volatile data) ─────────────────────

/**
 * Load the supervisor memory from disk.
 * Migrates from legacy memory.md if needed.
 */
export async function loadMemory(dir: string): Promise<string> {
  // Try new format first
  try {
    return await readFile(path.join(dir, MEMORY_FILE), "utf-8");
  } catch {
    // Not found — try legacy migration
  }

  // Migrate from legacy memory.md
  try {
    const legacy = await readFile(path.join(dir, LEGACY_FILE), "utf-8");
    if (legacy.trim()) {
      await writeFile(path.join(dir, MEMORY_FILE), legacy, "utf-8");
      await rename(path.join(dir, LEGACY_FILE), path.join(dir, `${LEGACY_FILE}.bak`));
      return legacy;
    }
  } catch {
    // No legacy file either
  }

  return "";
}

/**
 * Save the supervisor memory to disk (full overwrite).
 * Automatically compacts if needed.
 */
export async function saveMemory(dir: string, content: string): Promise<void> {
  const compacted = await compactMemory(dir, content);
  await writeFile(path.join(dir, MEMORY_FILE), compacted, "utf-8");
}

/**
 * Check if memory content exceeds the recommended size limit.
 */
export function checkMemorySize(content: string): {
  ok: boolean;
  sizeKB: number;
} {
  const sizeKB = Buffer.byteLength(content, "utf-8") / 1024;
  return { ok: sizeKB <= MAX_SIZE_KB, sizeKB: Math.round(sizeKB * 10) / 10 };
}

// ─── Legacy extractors (deprecated — remove in Phase 3) ─

/**
 * @deprecated Use extractMemoryOps() instead. Will be removed in Phase 3.
 */
export function extractMemoryFromResponse(response: string): string | null {
  const match = /<memory>([\s\S]*?)<\/memory>/i.exec(response);
  if (!match?.[1]) return null;
  const content = match[1].trim();
  if (content.startsWith("{")) {
    try {
      JSON.parse(content);
      return content;
    } catch {
      // Malformed JSON — still save as raw text
    }
  }
  return content;
}

/**
 * @deprecated Use extractKnowledgeOps() from knowledge.ts instead. Will be removed in Phase 3.
 */
export function extractKnowledgeFromResponse(response: string): string | null {
  const match = /<knowledge>([\s\S]*?)<\/knowledge>/i.exec(response);
  if (!match?.[1]) return null;
  return match[1].trim();
}

// ─── Memory delta operations ────────────────────────────

export function extractMemoryOps(response: string): MemoryOp[] {
  const match = /<memory-ops>([\s\S]*?)<\/memory-ops>/i.exec(response);
  if (!match?.[1]) return [];
  const ops: MemoryOp[] = [];
  for (const line of match[1].trim().split("\n").filter(Boolean)) {
    try {
      ops.push(memoryOpSchema.parse(JSON.parse(line)));
    } catch {}
  }
  return ops;
}

function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    if (current[part] == null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1] as string;
  current[lastKey] = value;
}

export function applyMemoryOps(memory: SupervisorMemory, ops: MemoryOp[]): SupervisorMemory {
  const clone = JSON.parse(JSON.stringify(memory)) as Record<string, unknown>;

  for (const op of ops) {
    switch (op.op) {
      case "set":
        setAtPath(clone, op.path, op.value);
        break;
      case "append": {
        const arr = getAtPath(clone, op.path);
        if (Array.isArray(arr)) {
          arr.push(op.value);
        } else {
          setAtPath(clone, op.path, [op.value]);
        }
        break;
      }
      case "remove": {
        const arr = getAtPath(clone, op.path);
        if (Array.isArray(arr) && op.index >= 0 && op.index < arr.length) {
          arr.splice(op.index, 1);
        }
        break;
      }
    }
  }

  return clone as unknown as SupervisorMemory;
}

export async function auditMemoryOps(
  dir: string,
  heartbeat: number,
  ops: MemoryOp[],
): Promise<void> {
  if (ops.length === 0) return;
  const entry = {
    type: "memory_ops",
    timestamp: new Date().toISOString(),
    heartbeat,
    ops,
  };
  const archivePath = path.join(dir, ARCHIVE_FILE);
  await appendFile(archivePath, `${JSON.stringify(entry)}\n`, "utf-8");
}

// ─── Compaction ─────────────────────────────────────────

/**
 * Compact memory: archive old decisions if over limit.
 * Archived data goes to memory-archive.jsonl (append-only, never lost).
 */
async function compactMemory(dir: string, content: string): Promise<string> {
  if (!content.startsWith("{")) return content;

  let parsed: SupervisorMemory;
  try {
    parsed = parseStructuredMemory(content);
  } catch {
    return content;
  }

  let changed = false;

  if (parsed.decisions.length > MAX_DECISIONS) {
    const toArchive = parsed.decisions.slice(0, -MAX_DECISIONS);
    parsed.decisions = parsed.decisions.slice(-MAX_DECISIONS);
    changed = true;

    const archivePath = path.join(dir, ARCHIVE_FILE);
    const entry = {
      type: "decisions_archived",
      timestamp: new Date().toISOString(),
      decisions: toArchive,
    };
    await appendFile(archivePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  return changed ? JSON.stringify(parsed, null, 2) : content;
}
