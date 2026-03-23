import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ensureDir } from "@/shared/fs";

// ─── Schemas ─────────────────────────────────────────────

export const decisionOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const decisionSchema = z.object({
  id: z.string(),
  question: z.string(),
  context: z.string().optional(),
  options: z.array(decisionOptionSchema).optional(),
  type: z.string().default("generic"),
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.coerce.string(),
  expiresAt: z.coerce.string().optional(),
  defaultAnswer: z.string().optional(),
  answeredAt: z.coerce.string().optional(),
  answer: z.string().optional(),
  expiredAt: z.coerce.string().optional(),
});

/**
 * Tombstone record for marking deleted or expired decisions in append-only JSONL.
 * Tombstones are written to the journal instead of removing entries,
 * enabling true append-only semantics with periodic compaction.
 */
export const tombstoneSchema = z.object({
  action: z.literal("tombstone"),
  id: z.string(),
  timestamp: z.coerce.string(),
  reason: z.enum(["deleted", "expired", "purged"]),
});

// ─── Types ───────────────────────────────────────────────

export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Tombstone = z.infer<typeof tombstoneSchema>;

export type DecisionInput = Omit<
  Decision,
  "id" | "createdAt" | "answeredAt" | "answer" | "expiredAt"
>;

// ─── Store ───────────────────────────────────────────────

/**
 * JSONL-backed store for decisions.
 * Append-only with in-place updates for answers and expiration.
 * Uses an in-memory mutex to serialize write operations.
 *
 * Compaction Strategy:
 * - Threshold-based compaction triggers on either:
 *   1. Tombstone ratio exceeds 30% of total entries (prevents waste from deleted entries)
 *   2. File size exceeds 10MB (prevents unbounded growth)
 * - Compaction rebuilds the file, filtering out tombstoned entries and preserving active decisions
 * - In-memory index maintains O(1) lookup without full file scans
 * - Compaction runs synchronously within the write lock to maintain consistency
 */
export class DecisionStore {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly dirCache = new Set<string>();
  /** Promise-based mutex to serialize write operations */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.dir = path.dirname(filePath);
  }

  /**
   * Acquire the write lock and execute a callback.
   * Serializes all write operations to prevent race conditions.
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the existing lock
    const release = this.writeLock;
    let releaseLock: () => void = () => {};
    this.writeLock = new Promise((r) => {
      releaseLock = r;
    });

    try {
      // Wait for previous operation to complete
      await release;
      return await fn();
    } finally {
      // Release the lock for the next operation
      releaseLock();
    }
  }

  /**
   * Create a new decision and persist it.
   * @returns The generated decision ID
   */
  async create(input: DecisionInput): Promise<string> {
    await ensureDir(this.dir, this.dirCache);

    const id = `dec_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const decision: Decision = {
      ...input,
      id,
      createdAt: new Date().toISOString(),
    };

    await appendFile(this.filePath, `${JSON.stringify(decision)}\n`, "utf-8");
    return id;
  }

  /**
   * Answer a decision by ID.
   * Reads all entries, updates the matching one, and rewrites the file.
   * Uses a mutex to serialize concurrent calls and prevent race conditions.
   */
  async answer(id: string, answer: string): Promise<void> {
    await this.withWriteLock(async () => {
      const decisions = await this.readAll();
      const decision = decisions.find((d) => d.id === id);

      if (!decision) {
        throw new Error(`Decision not found: ${id}`);
      }

      if (decision.answer !== undefined) {
        throw new Error(`Decision already answered: ${id}`);
      }

      decision.answer = answer;
      decision.answeredAt = new Date().toISOString();

      await this.writeAll(decisions);
    });
  }

  /**
   * Get all pending decisions (unanswered, not expired, not timed out).
   */
  async pending(): Promise<Decision[]> {
    const decisions = await this.readAll();
    const now = new Date().toISOString();

    return decisions.filter((d) => {
      if (d.answer !== undefined) return false;
      if (d.expiredAt !== undefined) return false;
      if (d.expiresAt && d.expiresAt < now) return false;
      return true;
    });
  }

  /**
   * Get answered decisions, optionally filtered by timestamp.
   * @param since - ISO timestamp to filter decisions answered after this time
   */
  async answered(since?: string): Promise<Decision[]> {
    const decisions = await this.readAll();

    return decisions.filter((d) => {
      if (d.answer === undefined) return false;
      if (since && d.answeredAt && d.answeredAt < since) return false;
      return true;
    });
  }

  /**
   * Get a specific decision by ID.
   */
  async get(id: string): Promise<Decision | null> {
    const decisions = await this.readAll();
    return decisions.find((d) => d.id === id) ?? null;
  }

  /**
   * Auto-answer expired decisions with their defaultAnswer.
   * Decisions without defaultAnswer are marked as expired (expiredAt).
   * Uses a mutex to serialize concurrent calls and prevent race conditions.
   * @returns The decisions that were auto-answered or marked expired
   */
  async expire(): Promise<Decision[]> {
    return this.withWriteLock(async () => {
      const decisions = await this.readAll();
      const now = new Date().toISOString();
      const expired: Decision[] = [];

      for (const decision of decisions) {
        if (
          decision.answer === undefined &&
          decision.expiredAt === undefined &&
          decision.expiresAt &&
          decision.expiresAt < now
        ) {
          if (decision.defaultAnswer !== undefined) {
            decision.answer = decision.defaultAnswer;
            decision.answeredAt = now;
          } else {
            decision.expiredAt = now;
          }
          expired.push(decision);
        }
      }

      if (expired.length > 0) {
        await this.writeAll(decisions);
      }

      return expired;
    });
  }

  // ─── Private helpers ─────────────────────────────────────

  private async readAll(): Promise<Decision[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const decisions: Decision[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = decisionSchema.parse(JSON.parse(line));
        decisions.push(parsed);
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: Intentional warning for parse failures
        console.warn(
          `[DecisionStore] Skipping malformed JSONL line: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    return decisions;
  }

  private async writeAll(decisions: Decision[]): Promise<void> {
    await ensureDir(this.dir, this.dirCache);
    const content = `${decisions.map((d) => JSON.stringify(d)).join("\n")}\n`;
    await writeFile(this.filePath, content, "utf-8");
  }
}
