import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectiveStore, parseDirectiveDuration } from "../supervisor/directive-store.js";

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

  describe("concurrency", () => {
    it("serializes concurrent toggle operations", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({ trigger: "idle", action: "concurrent test" });

      // Run multiple toggles concurrently
      await Promise.all([
        store.toggle(id, false),
        store.toggle(id, true),
        store.toggle(id, false),
        store.toggle(id, true),
      ]);

      // File should be valid JSONL (no corruption)
      const content = readFileSync(TEST_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      // Should have exactly 1 line (compacted after all writes)
      expect(lines.length).toBe(1);

      // Should be valid JSON
      expect(() => JSON.parse(lines[0]!)).not.toThrow();
    });

    it("serializes concurrent delete and toggle operations", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id1 = await store.create({ trigger: "idle", action: "action 1" });
      const id2 = await store.create({ trigger: "idle", action: "action 2" });

      // Concurrent operations on different directives
      await Promise.all([store.toggle(id1, false), store.delete(id2)]);

      const all = await store.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(id1);
      expect(all[0]?.enabled).toBe(false);
    });

    it("serializes concurrent markTriggered operations", async () => {
      const store = new DirectiveStore(TEST_FILE);
      const id = await store.create({ trigger: "idle", action: "test" });

      // Run multiple markTriggered concurrently
      await Promise.all([
        store.markTriggered(id),
        store.markTriggered(id),
        store.markTriggered(id),
      ]);

      // File should still be valid
      const content = readFileSync(TEST_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      expect(() => JSON.parse(lines[lines.length - 1]!)).not.toThrow();
    });
  });

  describe("atomic writes", () => {
    it("uses temp file pattern (no temp files left behind)", async () => {
      const store = new DirectiveStore(TEST_FILE);
      await store.create({ trigger: "idle", action: "test" });

      // Toggle to trigger writeAll
      const id = (await store.list())[0]!.id;
      await store.toggle(id, false);

      // Check no temp files left behind
      const dir = path.dirname(TEST_FILE);
      const files = require("node:fs").readdirSync(dir);
      const tempFiles = files.filter((f: string) => f.includes(".tmp"));
      expect(tempFiles).toHaveLength(0);
    });
  });
});

describe("DirectiveStore concurrent write safety", () => {
  const CONCURRENT_TEST_DIR = "/tmp/neo-directive-store-concurrent-test";
  const CONCURRENT_TEST_FILE = path.join(CONCURRENT_TEST_DIR, "directives.jsonl");

  beforeEach(() => {
    if (existsSync(CONCURRENT_TEST_DIR)) {
      rmSync(CONCURRENT_TEST_DIR, { recursive: true });
    }
    mkdirSync(CONCURRENT_TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(CONCURRENT_TEST_DIR)) {
      rmSync(CONCURRENT_TEST_DIR, { recursive: true });
    }
  });

  it("handles concurrent toggle calls without race conditions", async () => {
    const store = new DirectiveStore(CONCURRENT_TEST_FILE);
    const ids = await Promise.all([
      store.create({ trigger: "idle", action: "action-1" }),
      store.create({ trigger: "idle", action: "action-2" }),
      store.create({ trigger: "idle", action: "action-3" }),
    ]);

    // Toggle all directives concurrently
    await Promise.all([
      store.toggle(ids[0]!, false),
      store.toggle(ids[1]!, false),
      store.toggle(ids[2]!, false),
    ]);

    // All directives should be disabled
    const all = await store.list();
    expect(all.every((d) => d.enabled === false)).toBe(true);
  });

  it("handles concurrent markTriggered calls without data loss", async () => {
    const store = new DirectiveStore(CONCURRENT_TEST_FILE);
    const ids = await Promise.all([
      store.create({ trigger: "idle", action: "action-1" }),
      store.create({ trigger: "idle", action: "action-2" }),
      store.create({ trigger: "idle", action: "action-3" }),
    ]);

    // Mark all directives as triggered concurrently
    await Promise.all(ids.map((id) => store.markTriggered(id)));

    // All directives should have lastTriggeredAt set
    const all = await store.list();
    expect(all.every((d) => d.lastTriggeredAt !== undefined)).toBe(true);
  });

  it("handles concurrent delete calls without corruption", async () => {
    const store = new DirectiveStore(CONCURRENT_TEST_FILE);
    const ids = await Promise.all([
      store.create({ trigger: "idle", action: "action-1" }),
      store.create({ trigger: "idle", action: "action-2" }),
      store.create({ trigger: "idle", action: "action-3" }),
      store.create({ trigger: "idle", action: "action-4" }), // Keep this one
    ]);

    // Delete first 3 directives concurrently
    await Promise.all([store.delete(ids[0]!), store.delete(ids[1]!), store.delete(ids[2]!)]);

    // Only the 4th directive should remain
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.action).toBe("action-4");
  });

  it("handles mixed concurrent operations safely", async () => {
    const store = new DirectiveStore(CONCURRENT_TEST_FILE);

    // Create initial directives
    const id1 = await store.create({ trigger: "idle", action: "action-1" });
    const id2 = await store.create({ trigger: "idle", action: "action-2" });
    const id3 = await store.create({
      trigger: "idle",
      action: "action-3",
      expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // Old expired
    });

    // Run mixed operations concurrently
    await Promise.all([store.toggle(id1, false), store.markTriggered(id2), store.expireOld()]);

    // Verify state is consistent
    const all = await store.list();
    const d1 = all.find((d) => d.id === id1);
    const d2 = all.find((d) => d.id === id2);
    const d3 = all.find((d) => d.id === id3);

    expect(d1?.enabled).toBe(false);
    expect(d2?.lastTriggeredAt).toBeDefined();
    expect(d3).toBeUndefined(); // Should be removed by expireOld
  });
});

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
