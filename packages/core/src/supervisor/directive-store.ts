import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────

export const directiveTriggerSchema = z.enum(["idle", "startup", "shutdown"]);

export type DirectiveTrigger = z.infer<typeof directiveTriggerSchema>;

export const directiveSchema = z.object({
  id: z.string(),
  trigger: directiveTriggerSchema,
  action: z.string(),
  description: z.string().optional(),
  priority: z.number().default(0),
  enabled: z.boolean().default(true),
  createdAt: z.coerce.string(),
  expiresAt: z.coerce.string().optional(),
  lastTriggeredAt: z.coerce.string().optional(),
});

export type Directive = z.infer<typeof directiveSchema>;

export interface DirectiveCreateInput {
  trigger: DirectiveTrigger;
  action: string;
  description?: string;
  priority?: number;
  expiresAt?: string;
}

// ─── DirectiveStore ──────────────────────────────────────

/**
 * JSONL-based store for persistent directives.
 * Each line is a complete directive record (append-only with periodic compaction).
 */
export class DirectiveStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // ─── Create ────────────────────────────────────────────

  async create(input: DirectiveCreateInput): Promise<string> {
    const id = `dir_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    const directive: Directive = {
      id,
      trigger: input.trigger,
      action: input.action,
      description: input.description,
      priority: input.priority ?? 0,
      enabled: true,
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    await this.append(directive);
    return id;
  }

  // ─── Read ──────────────────────────────────────────────

  async get(id: string): Promise<Directive | undefined> {
    const all = await this.readAll();
    return all.get(id);
  }

  async list(): Promise<Directive[]> {
    const all = await this.readAll();
    return Array.from(all.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /**
   * Get active directives (enabled, not expired).
   * Optionally filter by trigger type.
   * Sorted by priority descending.
   */
  async active(trigger?: DirectiveTrigger): Promise<Directive[]> {
    const now = new Date().toISOString();
    const all = await this.readAll();

    return Array.from(all.values())
      .filter((d) => {
        if (!d.enabled) return false;
        if (d.expiresAt && d.expiresAt < now) return false;
        if (trigger && d.trigger !== trigger) return false;
        return true;
      })
      .sort((a, b) => b.priority - a.priority);
  }

  // ─── Update ────────────────────────────────────────────

  async toggle(id: string, enabled: boolean): Promise<void> {
    const all = await this.readAll();
    const directive = all.get(id);
    if (!directive) {
      throw new Error(`Directive not found: ${id}`);
    }

    directive.enabled = enabled;
    all.set(id, directive);
    await this.writeAll(all);
  }

  async markTriggered(id: string): Promise<void> {
    const all = await this.readAll();
    const directive = all.get(id);
    if (!directive) {
      throw new Error(`Directive not found: ${id}`);
    }

    directive.lastTriggeredAt = new Date().toISOString();
    all.set(id, directive);
    await this.writeAll(all);
  }

  // ─── Delete ────────────────────────────────────────────

  async delete(id: string): Promise<void> {
    const all = await this.readAll();
    if (!all.has(id)) {
      throw new Error(`Directive not found: ${id}`);
    }

    all.delete(id);
    await this.writeAll(all);
  }

  /**
   * Remove directives that expired more than 24 hours ago.
   * Returns IDs of removed directives.
   */
  async expireOld(): Promise<string[]> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const all = await this.readAll();
    const removed: string[] = [];

    for (const [id, directive] of all) {
      if (directive.expiresAt && directive.expiresAt < cutoff) {
        all.delete(id);
        removed.push(id);
      }
    }

    if (removed.length > 0) {
      await this.writeAll(all);
    }

    return removed;
  }

  // ─── Internal ──────────────────────────────────────────

  private async readAll(): Promise<Map<string, Directive>> {
    const map = new Map<string, Directive>();

    if (!existsSync(this.filePath)) {
      return map;
    }

    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const raw = JSON.parse(line);
          const directive = directiveSchema.parse(raw);
          map.set(directive.id, directive);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File doesn't exist or can't be read
    }

    return map;
  }

  private async writeAll(map: Map<string, Directive>): Promise<void> {
    const lines = Array.from(map.values())
      .map((d) => JSON.stringify(d))
      .join("\n");
    await writeFile(this.filePath, lines ? `${lines}\n` : "", "utf-8");
  }

  private async append(directive: Directive): Promise<void> {
    const line = `${JSON.stringify(directive)}\n`;
    await appendFile(this.filePath, line, "utf-8");
  }
}
