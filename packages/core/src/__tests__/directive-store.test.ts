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
