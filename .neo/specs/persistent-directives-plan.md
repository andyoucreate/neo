# Persistent Directives System Implementation Plan

**Goal:** Add persistent directives to the neo supervisor that can be stored with indefinite or time-bounded duration, trigger during idle phases, and support compound actions.

**Architecture:** New DirectiveStore following existing JSONL-based store patterns (DecisionStore). Directives are evaluated during idle heartbeats and injected into the supervisor prompt as actionable instructions. Time expiry uses ISO timestamps with flexible human-readable parsing.

**Tech Stack:** Zod schemas, JSONL persistence, citty CLI, existing heartbeat integration points

---

### Task 1: DirectiveStore Schema and Core Implementation

**Files:**
- Create: `packages/core/src/supervisor/directive-store.ts`
- Test: `packages/core/src/__tests__/directive-store.test.ts`

- [ ] **Step 1: Write the failing test for DirectiveStore**

```typescript
// packages/core/src/__tests__/directive-store.test.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectiveStore } from "../supervisor/directive-store.js";

const TEST_DIR = "/tmp/neo-directive-store-test";
const TEST_FILE = path.join(TEST_DIR, "directives.jsonl");

describe("DirectiveStore", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("create", () => {
    it("creates a directive with indefinite duration", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({
        trigger: "idle",
        action: "launch a scout and implement its findings",
        description: "Proactive exploration",
      });

      expect(id).toMatch(/^dir_/);
      const directive = await store.get(id);
      expect(directive?.trigger).toBe("idle");
      expect(directive?.action).toBe("launch a scout and implement its findings");
      expect(directive?.expiresAt).toBeUndefined();
      expect(directive?.enabled).toBe(true);
    });

    it("creates a directive with time-bounded duration", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours
      const id = await store.create({
        trigger: "idle",
        action: "run tests on all repos",
        expiresAt,
      });

      const directive = await store.get(id);
      expect(directive?.expiresAt).toBe(expiresAt);
    });

    it("creates a directive with priority", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({
        trigger: "idle",
        action: "check CI status",
        priority: 10,
      });

      const directive = await store.get(id);
      expect(directive?.priority).toBe(10);
    });
  });

  describe("active", () => {
    it("returns only enabled and non-expired directives", async () => {
      const store = new DirectiveStore(TEST_FILE);

      // Active indefinite
      await store.create({
        trigger: "idle",
        action: "action 1",
      });

      // Active with future expiry
      await store.create({
        trigger: "idle",
        action: "action 2",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      // Expired
      await store.create({
        trigger: "idle",
        action: "action 3",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const active = await store.active();
      expect(active).toHaveLength(2);
      expect(active.map((d) => d.action)).toContain("action 1");
      expect(active.map((d) => d.action)).toContain("action 2");
    });

    it("filters by trigger type", async () => {
      const store = new DirectiveStore(TEST_FILE);

      await store.create({ trigger: "idle", action: "idle action" });
      await store.create({ trigger: "startup", action: "startup action" });

      const idleDirectives = await store.active("idle");
      expect(idleDirectives).toHaveLength(1);
      expect(idleDirectives[0]?.action).toBe("idle action");
    });

    it("sorts by priority descending", async () => {
      const store = new DirectiveStore(TEST_FILE);

      await store.create({ trigger: "idle", action: "low", priority: 1 });
      await store.create({ trigger: "idle", action: "high", priority: 10 });
      await store.create({ trigger: "idle", action: "medium", priority: 5 });

      const active = await store.active();
      expect(active[0]?.action).toBe("high");
      expect(active[1]?.action).toBe("medium");
      expect(active[2]?.action).toBe("low");
    });
  });

  describe("toggle", () => {
    it("disables an enabled directive", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({ trigger: "idle", action: "test" });

      await store.toggle(id, false);
      const directive = await store.get(id);
      expect(directive?.enabled).toBe(false);

      const active = await store.active();
      expect(active).toHaveLength(0);
    });

    it("enables a disabled directive", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({ trigger: "idle", action: "test" });
      await store.toggle(id, false);
      await store.toggle(id, true);

      const directive = await store.get(id);
      expect(directive?.enabled).toBe(true);
    });
  });

  describe("delete", () => {
    it("removes a directive", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({ trigger: "idle", action: "test" });

      await store.delete(id);
      const directive = await store.get(id);
      expect(directive).toBeUndefined();
    });
  });

  describe("markTriggered", () => {
    it("updates lastTriggeredAt timestamp", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({ trigger: "idle", action: "test" });

      const before = await store.get(id);
      expect(before?.lastTriggeredAt).toBeUndefined();

      await store.markTriggered(id);
      const after = await store.get(id);
      expect(after?.lastTriggeredAt).toBeDefined();
    });
  });

  describe("list", () => {
    it("returns all directives including disabled and expired", async () => {
      const store = new DirectiveStore(TEST_FILE);

      await store.create({ trigger: "idle", action: "active" });
      const disabledId = await store.create({ trigger: "idle", action: "disabled" });
      await store.toggle(disabledId, false);
      await store.create({
        trigger: "idle",
        action: "expired",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const all = await store.list();
      expect(all).toHaveLength(3);
    });
  });

  describe("expireOld", () => {
    it("removes directives that expired more than 24h ago", async () => {
      const store = new DirectiveStore(TEST_FILE);

      // Recently expired (keep)
      await store.create({
        trigger: "idle",
        action: "recent",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      // Old expired (remove) - manually inject for testing
      const oldId = await store.create({
        trigger: "idle",
        action: "old",
        expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      });

      const removed = await store.expireOld();
      expect(removed).toHaveLength(1);
      expect(removed[0]).toBe(oldId);

      const all = await store.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.action).toBe("recent");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/directive-store.test.ts`
Expected: FAIL with "Cannot find module '../supervisor/directive-store.js'"

- [ ] **Step 3: Write the DirectiveStore implementation**

```typescript
// packages/core/src/supervisor/directive-store.ts
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
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/directive-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/directive-store.ts packages/core/src/__tests__/directive-store.test.ts
git commit -m "feat(core): add DirectiveStore for persistent directives

- JSONL-based storage following DecisionStore pattern
- Support indefinite and time-bounded directives
- Priority ordering and trigger filtering
- Automatic expiry cleanup

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Time Parsing Utilities

**Files:**
- Modify: `packages/core/src/supervisor/directive-store.ts`
- Test: `packages/core/src/__tests__/directive-store.test.ts`

- [ ] **Step 1: Add time parsing tests**

```typescript
// Add to packages/core/src/__tests__/directive-store.test.ts

import { parseDirectiveDuration } from "../supervisor/directive-store.js";

describe("parseDirectiveDuration", () => {
  it("parses 'for X hours' format", () => {
    const now = Date.now();
    const result = parseDirectiveDuration("for 2 hours");
    expect(result).toBeDefined();
    const diff = new Date(result!).getTime() - now;
    // Allow 1 second tolerance
    expect(diff).toBeGreaterThan(2 * 60 * 60 * 1000 - 1000);
    expect(diff).toBeLessThan(2 * 60 * 60 * 1000 + 1000);
  });

  it("parses 'for X minutes' format", () => {
    const now = Date.now();
    const result = parseDirectiveDuration("for 30 minutes");
    expect(result).toBeDefined();
    const diff = new Date(result!).getTime() - now;
    expect(diff).toBeGreaterThan(30 * 60 * 1000 - 1000);
    expect(diff).toBeLessThan(30 * 60 * 1000 + 1000);
  });

  it("parses 'until midnight' format", () => {
    const result = parseDirectiveDuration("until midnight");
    expect(result).toBeDefined();

    const midnight = new Date();
    midnight.setHours(23, 59, 59, 999);
    // Result should be before or at midnight
    expect(new Date(result!).getTime()).toBeLessThanOrEqual(midnight.getTime() + 1000);
  });

  it("parses 'until HH:MM' format", () => {
    const result = parseDirectiveDuration("until 18:00");
    expect(result).toBeDefined();

    const parsed = new Date(result!);
    expect(parsed.getHours()).toBe(18);
    expect(parsed.getMinutes()).toBe(0);
  });

  it("parses shorthand '2h' format", () => {
    const now = Date.now();
    const result = parseDirectiveDuration("2h");
    expect(result).toBeDefined();
    const diff = new Date(result!).getTime() - now;
    expect(diff).toBeGreaterThan(2 * 60 * 60 * 1000 - 1000);
  });

  it("parses shorthand '30m' format", () => {
    const now = Date.now();
    const result = parseDirectiveDuration("30m");
    expect(result).toBeDefined();
    const diff = new Date(result!).getTime() - now;
    expect(diff).toBeGreaterThan(30 * 60 * 1000 - 1000);
  });

  it("parses shorthand '7d' format", () => {
    const now = Date.now();
    const result = parseDirectiveDuration("7d");
    expect(result).toBeDefined();
    const diff = new Date(result!).getTime() - now;
    expect(diff).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 1000);
  });

  it("returns undefined for 'indefinitely'", () => {
    const result = parseDirectiveDuration("indefinitely");
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const result = parseDirectiveDuration("");
    expect(result).toBeUndefined();
  });

  it("returns undefined for invalid format", () => {
    const result = parseDirectiveDuration("invalid");
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/core/src/__tests__/directive-store.test.ts`
Expected: FAIL with "parseDirectiveDuration is not a function"

- [ ] **Step 3: Implement parseDirectiveDuration**

```typescript
// Add to packages/core/src/supervisor/directive-store.ts (before DirectiveStore class)

/**
 * Parse a human-readable duration string into an ISO timestamp.
 *
 * Supported formats:
 * - "for X hours" / "for X minutes" / "for X days"
 * - "until midnight"
 * - "until HH:MM"
 * - "2h" / "30m" / "7d" (shorthand)
 * - "indefinitely" / "" → returns undefined (no expiry)
 *
 * @returns ISO timestamp string or undefined for indefinite
 */
export function parseDirectiveDuration(input: string): string | undefined {
  const trimmed = input.trim().toLowerCase();

  // Indefinite
  if (!trimmed || trimmed === "indefinitely" || trimmed === "forever") {
    return undefined;
  }

  const now = new Date();

  // Shorthand: 2h, 30m, 7d
  const shorthandMatch = trimmed.match(/^(\d+)(h|m|d)$/);
  if (shorthandMatch) {
    const value = Number(shorthandMatch[1]);
    const unit = shorthandMatch[2];
    let ms = 0;
    switch (unit) {
      case "h":
        ms = value * 60 * 60 * 1000;
        break;
      case "m":
        ms = value * 60 * 1000;
        break;
      case "d":
        ms = value * 24 * 60 * 60 * 1000;
        break;
    }
    return new Date(now.getTime() + ms).toISOString();
  }

  // "for X hours/minutes/days"
  const forMatch = trimmed.match(/^for\s+(\d+)\s+(hour|minute|day|hr|min)s?$/);
  if (forMatch) {
    const value = Number(forMatch[1]);
    const unit = forMatch[2];
    let ms = 0;
    switch (unit) {
      case "hour":
      case "hr":
        ms = value * 60 * 60 * 1000;
        break;
      case "minute":
      case "min":
        ms = value * 60 * 1000;
        break;
      case "day":
        ms = value * 24 * 60 * 60 * 1000;
        break;
    }
    return new Date(now.getTime() + ms).toISOString();
  }

  // "until midnight"
  if (trimmed === "until midnight") {
    const midnight = new Date(now);
    midnight.setHours(23, 59, 59, 999);
    return midnight.toISOString();
  }

  // "until HH:MM"
  const untilTimeMatch = trimmed.match(/^until\s+(\d{1,2}):(\d{2})$/);
  if (untilTimeMatch) {
    const hours = Number(untilTimeMatch[1]);
    const minutes = Number(untilTimeMatch[2]);
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    // If the time has already passed today, set for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.toISOString();
  }

  // Unrecognized format
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/core/src/__tests__/directive-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/directive-store.ts packages/core/src/__tests__/directive-store.test.ts
git commit -m "feat(core): add parseDirectiveDuration for human-readable time parsing

Supports: 'for X hours', 'until midnight', 'until HH:MM', '2h', '30m', '7d'

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Export DirectiveStore from Core Package

**Files:**
- Modify: `packages/core/src/supervisor/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Export from supervisor module**

```typescript
// Add to packages/core/src/supervisor/index.ts

export {
  DirectiveStore,
  parseDirectiveDuration,
  type Directive,
  type DirectiveCreateInput,
  type DirectiveTrigger,
} from "./directive-store.js";
```

- [ ] **Step 2: Verify supervisor index exports**

Run: `pnpm build --filter @neotx/core`
Expected: Build succeeds

- [ ] **Step 3: Export from core package root**

```typescript
// Add to packages/core/src/index.ts (in the supervisor exports section)

export {
  DirectiveStore,
  parseDirectiveDuration,
  type Directive,
  type DirectiveCreateInput,
  type DirectiveTrigger,
} from "./supervisor/index.js";
```

- [ ] **Step 4: Verify core package exports**

Run: `pnpm build --filter @neotx/core && pnpm typecheck --filter @neotx/core`
Expected: Build and typecheck pass

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/index.ts packages/core/src/index.ts
git commit -m "feat(core): export DirectiveStore from package root

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 4: CLI Command Implementation

**Files:**
- Create: `packages/cli/src/commands/directive.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Create the directive CLI command**

```typescript
// packages/cli/src/commands/directive.ts
import path from "node:path";
import {
  DirectiveStore,
  getSupervisorDir,
  parseDirectiveDuration,
  type DirectiveTrigger,
} from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess, printTable } from "../output.js";

const VALID_TRIGGERS = ["idle", "startup", "shutdown"] as const;

interface ParsedArgs {
  action: string;
  value: string | undefined;
  trigger: string;
  duration: string | undefined;
  priority: string | undefined;
  description: string | undefined;
  name: string;
}

function openStore(name: string): DirectiveStore {
  const dir = getSupervisorDir(name);
  return new DirectiveStore(path.join(dir, "directives.jsonl"));
}

function formatExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return "∞";
  const date = new Date(expiresAt);
  const now = new Date();
  if (date < now) return "expired";

  const diffMs = date.getTime() - now.getTime();
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

async function handleCreate(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError('Usage: neo directive create "<action>" [--trigger idle] [--duration "2h"]');
    process.exitCode = 1;
    return;
  }

  const trigger = args.trigger as DirectiveTrigger;
  if (!VALID_TRIGGERS.includes(trigger)) {
    printError(`Invalid trigger "${trigger}". Must be one of: ${VALID_TRIGGERS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  let expiresAt: string | undefined;
  if (args.duration) {
    expiresAt = parseDirectiveDuration(args.duration);
    // parseDirectiveDuration returns undefined for "indefinitely" which is valid
    // But if user provided something and we got undefined, it might be invalid format
    // Check against known indefinite keywords
    const isIndefinite = ["indefinitely", "forever", ""].includes(args.duration.toLowerCase().trim());
    if (expiresAt === undefined && !isIndefinite) {
      printError(
        `Invalid --duration format "${args.duration}". Use: "2h", "30m", "for 2 hours", "until midnight", "until 18:00", or "indefinitely"`
      );
      process.exitCode = 1;
      return;
    }
  }

  const store = openStore(args.name);
  const id = await store.create({
    trigger,
    action: args.value,
    description: args.description,
    priority: args.priority ? Number(args.priority) : undefined,
    expiresAt,
  });

  const expiryLabel = expiresAt ? formatExpiry(expiresAt) : "indefinitely";
  printSuccess(`Directive created: ${id}`);
  console.log(`  Trigger: ${trigger}`);
  console.log(`  Action: ${args.value}`);
  console.log(`  Duration: ${expiryLabel}`);
}

async function handleList(args: ParsedArgs): Promise<void> {
  const store = openStore(args.name);
  const directives = await store.list();

  if (directives.length === 0) {
    console.log("No directives found.");
    return;
  }

  printTable(
    ["ID", "TRIGGER", "STATUS", "EXPIRES", "PRIORITY", "ACTION"],
    directives.map((d) => {
      const now = new Date().toISOString();
      let status = d.enabled ? "active" : "disabled";
      if (d.expiresAt && d.expiresAt < now) {
        status = "expired";
      }

      return [
        d.id,
        d.trigger,
        status,
        formatExpiry(d.expiresAt),
        String(d.priority),
        d.action.length > 40 ? `${d.action.slice(0, 37)}...` : d.action,
      ];
    })
  );
}

async function handleDelete(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo directive delete <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    await store.delete(args.value);
    printSuccess(`Directive deleted: ${args.value}`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function handleToggle(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo directive toggle <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    const directive = await store.get(args.value);
    if (!directive) {
      printError(`Directive not found: ${args.value}`);
      process.exitCode = 1;
      return;
    }

    const newState = !directive.enabled;
    await store.toggle(args.value, newState);
    printSuccess(`Directive ${args.value} ${newState ? "enabled" : "disabled"}`);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function handleShow(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo directive show <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  const directive = await store.get(args.value);

  if (!directive) {
    printError(`Directive not found: ${args.value}`);
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  let status = directive.enabled ? "active" : "disabled";
  if (directive.expiresAt && directive.expiresAt < now) {
    status = "expired";
  }

  console.log(`ID:          ${directive.id}`);
  console.log(`Trigger:     ${directive.trigger}`);
  console.log(`Status:      ${status}`);
  console.log(`Priority:    ${directive.priority}`);
  console.log(`Action:      ${directive.action}`);
  if (directive.description) {
    console.log(`Description: ${directive.description}`);
  }
  console.log(`Created:     ${directive.createdAt}`);
  if (directive.expiresAt) {
    console.log(`Expires:     ${directive.expiresAt} (${formatExpiry(directive.expiresAt)})`);
  } else {
    console.log(`Expires:     never (indefinite)`);
  }
  if (directive.lastTriggeredAt) {
    console.log(`Last triggered: ${directive.lastTriggeredAt}`);
  }
}

export default defineCommand({
  meta: {
    name: "directive",
    description: "Manage persistent supervisor directives",
  },
  args: {
    action: {
      type: "positional",
      description: "Action: create, list, delete, toggle, show",
      required: true,
    },
    value: {
      type: "positional",
      description: "Action text or directive ID",
      required: false,
    },
    trigger: {
      type: "string",
      alias: "t",
      description: "Trigger type: idle, startup, shutdown",
      default: "idle",
    },
    duration: {
      type: "string",
      alias: "d",
      description: 'Duration: "2h", "until midnight", "for 2 hours", "indefinitely"',
    },
    priority: {
      type: "string",
      alias: "p",
      description: "Priority (higher = execute first)",
      default: "0",
    },
    description: {
      type: "string",
      description: "Human-readable description",
    },
    name: {
      type: "string",
      description: "Supervisor name",
      default: "supervisor",
    },
  },
  async run({ args }) {
    const action = args.action as string;
    const parsed: ParsedArgs = {
      action,
      value: args.value as string | undefined,
      trigger: args.trigger as string,
      duration: args.duration as string | undefined,
      priority: args.priority as string | undefined,
      description: args.description as string | undefined,
      name: args.name as string,
    };

    switch (action) {
      case "create":
        return handleCreate(parsed);
      case "list":
        return handleList(parsed);
      case "delete":
        return handleDelete(parsed);
      case "toggle":
        return handleToggle(parsed);
      case "show":
        return handleShow(parsed);
      default:
        printError(
          `Unknown action "${action}". Must be one of: create, list, delete, toggle, show`
        );
        process.exitCode = 1;
    }
  },
});
```

- [ ] **Step 2: Register the directive command in CLI**

```typescript
// Add to packages/cli/src/index.ts (in the subCommands object)

import directive from "./commands/directive.js";

// In the subCommands object:
directive,
```

- [ ] **Step 3: Build and verify CLI**

Run: `pnpm build --filter neotx && pnpm exec neo directive list`
Expected: "No directives found." (empty list)

- [ ] **Step 4: Test CLI manually**

Run: `pnpm exec neo directive create "launch scout and implement findings" --duration "2h"`
Expected: "Directive created: dir_..."

Run: `pnpm exec neo directive list`
Expected: Shows the created directive

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/directive.ts packages/cli/src/index.ts
git commit -m "feat(cli): add neo directive command

Commands: create, list, delete, toggle, show
Supports: --trigger, --duration, --priority, --description

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Heartbeat Integration - DirectiveStore Initialization

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Add DirectiveStore to HeartbeatLoop**

Add to imports at top of file:
```typescript
import { DirectiveStore } from "./directive-store.js";
```

Add to HeartbeatLoopOptions interface:
```typescript
/** Path to directives storage */
directivesPath?: string | undefined;
```

Add property to HeartbeatLoop class:
```typescript
private directiveStore: DirectiveStore | null = null;
private readonly directivesPath: string | undefined;
```

Add to constructor:
```typescript
this.directivesPath = options.directivesPath;
```

Add getter method:
```typescript
private getDirectiveStore(): DirectiveStore | null {
  if (!this.directiveStore && this.directivesPath) {
    try {
      this.directiveStore = new DirectiveStore(this.directivesPath);
    } catch {
      // Directive store unavailable — continue without it
    }
  }
  return this.directiveStore;
}
```

- [ ] **Step 2: Build and verify no regressions**

Run: `pnpm build --filter @neotx/core && pnpm test --filter @neotx/core`
Expected: Build and tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(core): add DirectiveStore to HeartbeatLoop

Initialize store from directivesPath option

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Prompt Builder - Add Directives Section

**Files:**
- Modify: `packages/core/src/supervisor/prompt-builder.ts`

- [ ] **Step 1: Add Directive type import and PromptOptions field**

Add to imports:
```typescript
import type { Directive } from "./directive-store.js";
```

Add to PromptOptions interface:
```typescript
/** Active directives to evaluate during idle */
activeDirectives?: Directive[] | undefined;
```

- [ ] **Step 2: Create buildDirectivesSection function**

Add after buildAnsweredDecisionsSection function:
```typescript
/**
 * Build the active directives section.
 * Directives are persistent instructions that trigger during idle phases.
 */
function buildDirectivesSection(directives: Directive[] | undefined): string {
  if (!directives || directives.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const d of directives) {
    const priority = d.priority > 0 ? ` [priority: ${d.priority}]` : "";
    const desc = d.description ? ` — ${d.description}` : "";
    lines.push(`- **${d.id}**${priority}: ${d.action}${desc}`);
  }

  return `Active directives (${directives.length}):
${lines.join("\n")}

**Directive protocol:**
1. Evaluate each directive in priority order
2. Execute the specified action as if it were a user request
3. After executing, the directive remains active until its expiry or manual deletion
4. For compound actions (e.g., "launch scout and implement findings"), complete all steps before moving to the next directive`;
}
```

- [ ] **Step 3: Integrate directives into buildIdlePrompt**

Modify buildIdlePrompt to include directives section:

Find the section where hasPendingDecisions is checked and add directive handling before the final return:

```typescript
// After the hasPendingDecisions block, add:

// If there are active directives to execute
const hasDirectives = (opts.activeDirectives?.length ?? 0) > 0;
if (hasDirectives) {
  const directivesSection = buildDirectivesSection(opts.activeDirectives);

  return `${buildRoleSection(opts.heartbeatCount)}

<context>
No events. No active runs. No pending tasks.
${budgetLine}

${directivesSection}

Repositories:
${repoList}
</context>

<reference>
${getCommandsSection(opts.heartbeatCount)}
</reference>

<directive>
Idle — but there are active directives to execute. Process each directive in priority order:
${opts.activeDirectives?.map((d) => `- ${d.action}`).join("\n")}

After completing all directives, yield.
</directive>`;
}
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build --filter @neotx/core && pnpm typecheck --filter @neotx/core`
Expected: Build and typecheck pass

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor/prompt-builder.ts
git commit -m "feat(core): add directives section to idle prompt

Directives are injected during idle phases with priority ordering

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 7: Heartbeat Integration - Fetch and Pass Directives

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Add directive fetching to gatherEventContext**

Modify the EventContext interface to include directives:
```typescript
interface EventContext {
  grouped: GroupedEvents;
  rawEvents: QueuedEvent[];
  totalEventCount: number;
  activeRuns: string[];
  memories: MemoryEntry[];
  tasks: TaskEntry[];
  recentActions: ActivityEntry[];
  mcpServerNames: string[];
  activeDirectives: Directive[];  // Add this
}
```

Import Directive type:
```typescript
import type { Directive } from "./directive-store.js";
```

Modify gatherEventContext to fetch directives:
```typescript
private async gatherEventContext(): Promise<EventContext> {
  const { grouped, rawEvents } = this.eventQueue.drainAndGroup();
  const totalEventCount =
    grouped.messages.length + grouped.webhooks.length + grouped.runCompletions.length;
  const activeRuns = await this.getActiveRuns();

  const mcpServerNames = this.config.mcpServers ? Object.keys(this.config.mcpServers) : [];
  const store = this.getMemoryStore();
  const memories: MemoryEntry[] = store ? store.query({ limit: 40, sortBy: "relevance" }) : [];
  const taskStore = this.getTaskStore();
  const tasks: TaskEntry[] = taskStore ? taskStore.getTasks() : [];
  const recentActions = await this.activityLog.tail(20);

  // Fetch active idle directives
  const directiveStore = this.getDirectiveStore();
  const activeDirectives: Directive[] = directiveStore
    ? await directiveStore.active("idle")
    : [];

  return {
    grouped,
    rawEvents,
    totalEventCount,
    activeRuns,
    memories,
    tasks,
    recentActions,
    mcpServerNames,
    activeDirectives,
  };
}
```

- [ ] **Step 2: Pass directives to prompt builder**

Modify buildHeartbeatModePrompt to include activeDirectives:

In the sharedOpts object, add:
```typescript
activeDirectives: opts.activeDirectives,
```

Update the function signature:
```typescript
private async buildHeartbeatModePrompt(opts: {
  grouped: GroupedEvents;
  todayCost: number;
  heartbeatCount: number;
  unconsolidated: LogBufferEntry[];
  isCompaction: boolean;
  isConsolidation: boolean;
  activeRuns: string[];
  pendingDecisions: Decision[];
  answeredDecisions: Decision[];
  hasPendingDecisions: boolean;
  lastHeartbeat: string | undefined;
  lastConsolidationTimestamp: string | undefined;
  memories: MemoryEntry[];
  tasks: TaskEntry[];
  recentActions: ActivityEntry[];
  mcpServerNames: string[];
  activeDirectives: Directive[];  // Add this
}): Promise<{ prompt: string; modeLabel: string }>
```

Update the call site in runHeartbeat:
```typescript
const { prompt, modeLabel } = await this.buildHeartbeatModePrompt({
  // ... existing fields ...
  activeDirectives: eventCtx.activeDirectives,
});
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build --filter @neotx/core && pnpm typecheck --filter @neotx/core`
Expected: Build and typecheck pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(core): fetch and pass directives to prompt builder

Directives are fetched during gatherEventContext and passed to idle prompt

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 8: Supervisor Daemon Integration

**Files:**
- Modify: `packages/core/src/supervisor/daemon.ts`

- [ ] **Step 1: Pass directivesPath to HeartbeatLoop**

Add to the HeartbeatLoop instantiation in startSupervisor or similar function:
```typescript
directivesPath: path.join(supervisorDir, "directives.jsonl"),
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build --filter @neotx/core && pnpm test --filter @neotx/core`
Expected: Build and tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/supervisor/daemon.ts
git commit -m "feat(core): pass directivesPath to HeartbeatLoop

Enables directive evaluation during supervisor heartbeats

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 9: Add Directive Cleanup to Compaction

**Files:**
- Modify: `packages/core/src/supervisor/heartbeat.ts`

- [ ] **Step 1: Add directive expiry to post-SDK processing**

In handlePostSdkProcessing, add directive cleanup for compaction heartbeats:
```typescript
// After the consolidation block, add:
// Clean up old expired directives during compaction
if (input.isCompaction) {
  const directiveStore = this.getDirectiveStore();
  if (directiveStore) {
    const expired = await directiveStore.expireOld();
    if (expired.length > 0) {
      await this.activityLog.log(
        "event",
        `Cleaned up ${expired.length} expired directive(s)`,
        { expiredIds: expired }
      );
    }
  }
}
```

Wait - we need to also pass isCompaction to handlePostSdkProcessing. Update the interface:
```typescript
interface PostSdkProcessingInput {
  rawEvents: QueuedEvent[];
  isConsolidation: boolean;
  isCompaction: boolean;  // Add this
  unconsolidated: LogBufferEntry[];
}
```

Update the call site:
```typescript
await this.handlePostSdkProcessing({
  rawEvents: eventCtx.rawEvents,
  isConsolidation: modeResult.isConsolidation,
  isCompaction: modeResult.isCompaction,  // Add this
  unconsolidated: modeResult.unconsolidated,
});
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build --filter @neotx/core && pnpm test --filter @neotx/core`
Expected: Build and tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/supervisor/heartbeat.ts
git commit -m "feat(core): clean up expired directives during compaction

Directives expired >24h ago are automatically removed

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 10: Update SUPERVISOR.md Documentation

**Files:**
- Modify: `packages/agents/SUPERVISOR.md`

- [ ] **Step 1: Add Directives section to SUPERVISOR.md**

Add after the "Idle Behavior" section:
```markdown
## Directives

Directives are persistent instructions that trigger during specific phases (idle, startup, shutdown).

### Commands

```bash
# Create a directive (indefinite)
neo directive create "launch scout and implement findings" --trigger idle

# Create a time-bounded directive
neo directive create "run tests on all repos" --trigger idle --duration "until midnight"
neo directive create "check CI status every heartbeat" --trigger idle --duration "for 2 hours"

# List all directives
neo directive list

# Show details
neo directive show <id>

# Disable/enable
neo directive toggle <id>

# Delete
neo directive delete <id>
```

### Duration formats

- `2h`, `30m`, `7d` — shorthand for hours, minutes, days
- `for 2 hours`, `for 30 minutes` — natural language
- `until midnight` — until end of day
- `until 18:00` — until specific time
- `indefinitely` or omit `--duration` — never expires

### Priority

Higher priority directives execute first. Use `--priority 10` to ensure critical directives run before others.

### Trigger types

| Trigger | When it fires |
|---------|---------------|
| `idle` | No events, no active runs, no pending tasks |
| `startup` | Supervisor starts (not yet implemented) |
| `shutdown` | Supervisor stops (not yet implemented) |

### Examples

```bash
# Proactive exploration: scout repos when idle
neo directive create "launch a scout on the first repo without a recent scout run" \
  --trigger idle \
  --priority 5 \
  --description "Proactive codebase exploration"

# Time-bounded: until end of work day
neo directive create "when idle: check all open PRs and ensure CI is green" \
  --trigger idle \
  --duration "until 18:00" \
  --priority 10

# Compound action
neo directive create "launch scout, then for each CRITICAL finding create a developer task" \
  --trigger idle \
  --duration "2h"
```

### Behavior

- Directives are evaluated during **idle heartbeats** only
- Multiple directives execute in priority order (highest first)
- A directive remains active until it expires or is manually deleted
- For compound actions, complete all steps before moving to the next directive
- Directives persist across supervisor restarts
```

- [ ] **Step 2: Verify markdown formatting**

Run: `cat packages/agents/SUPERVISOR.md | head -100`
Expected: Well-formatted markdown

- [ ] **Step 3: Commit**

```bash
git add packages/agents/SUPERVISOR.md
git commit -m "docs(agents): add Directives section to SUPERVISOR.md

Documents: commands, duration formats, priority, trigger types, examples

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 11: Add Commands Manifest Entry

**Files:**
- Modify: `packages/core/src/supervisor/commands-manifest.ts`

- [ ] **Step 1: Add directive commands to manifest**

Add a new section to NEO_COMMANDS array:
```typescript
{
  category: "Directives",
  description: "Persistent idle-triggered instructions",
  commands: [
    {
      name: "neo directive create",
      syntax:
        'neo directive create "<action>" [--trigger idle] [--duration "2h"] [--priority 0]',
      description: "Create a persistent directive",
      compactSyntax: 'neo directive create "<action>" [--duration "2h"]',
    },
    {
      name: "neo directive list",
      syntax: "neo directive list",
      description: "List all directives",
    },
    {
      name: "neo directive delete",
      syntax: "neo directive delete <id>",
      description: "Delete a directive",
    },
    {
      name: "neo directive toggle",
      syntax: "neo directive toggle <id>",
      description: "Enable/disable a directive",
    },
  ],
  sectionNotes:
    "Directives trigger during idle phases. Use `--duration` for time-bounded directives: '2h', 'until midnight', 'for 2 hours', 'indefinitely'.",
},
```

- [ ] **Step 2: Build and verify**

Run: `pnpm build --filter @neotx/core`
Expected: Build passes

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/supervisor/commands-manifest.ts
git commit -m "feat(core): add directive commands to manifest

Includes create, list, delete, toggle commands

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 12: Integration Test

**Files:**
- Create: `packages/cli/src/__tests__/directive.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// packages/cli/src/__tests__/directive.test.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";

const TEST_DIR = "/tmp/neo-directive-cli-test";

describe("neo directive CLI", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.NEO_DATA_DIR = TEST_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    delete process.env.NEO_DATA_DIR;
  });

  it("creates and lists a directive", () => {
    const createOutput = execSync(
      'pnpm exec neo directive create "test action" --duration 2h',
      { encoding: "utf-8" }
    );
    expect(createOutput).toContain("Directive created: dir_");

    const listOutput = execSync("pnpm exec neo directive list", {
      encoding: "utf-8",
    });
    expect(listOutput).toContain("test action");
    expect(listOutput).toContain("idle");
    expect(listOutput).toContain("active");
  });

  it("handles indefinite duration", () => {
    const createOutput = execSync(
      'pnpm exec neo directive create "forever action"',
      { encoding: "utf-8" }
    );
    expect(createOutput).toContain("Duration: indefinitely");
  });

  it("handles until midnight duration", () => {
    const createOutput = execSync(
      'pnpm exec neo directive create "midnight action" --duration "until midnight"',
      { encoding: "utf-8" }
    );
    expect(createOutput).toContain("Directive created");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `pnpm test -- packages/cli/src/__tests__/directive.test.ts`
Expected: PASS (may need to skip if CI doesn't have neo in PATH)

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/__tests__/directive.test.ts
git commit -m "test(cli): add directive CLI integration tests

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 13: Final Validation

- [ ] **Step 1: Run full test suite**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: All tests pass

- [ ] **Step 2: Manual validation**

Run: `pnpm exec neo directive create "when idle, check all open PRs" --duration "2h"`
Run: `pnpm exec neo directive list`
Run: `pnpm exec neo directive show <id>`
Run: `pnpm exec neo directive toggle <id>`
Run: `pnpm exec neo directive delete <id>`

Expected: All commands work correctly

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "chore: final validation and fixes

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Summary

- **Files created:** 3 (directive-store.ts, directive.ts CLI, directive-store.test.ts)
- **Files modified:** 7 (heartbeat.ts, prompt-builder.ts, daemon.ts, SUPERVISOR.md, commands-manifest.ts, index exports)
- **Total tasks:** 13
- **Key risks:**
  - Integration with existing idle detection logic must preserve existing behavior
  - Time parsing edge cases (timezone handling, past times)
  - JSONL file locking not implemented (acceptable for single-supervisor setups)
