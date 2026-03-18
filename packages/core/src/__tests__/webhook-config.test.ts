import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_webhook_config__");

vi.mock("@/paths", () => ({
  getDataDir: () => TMP_DIR,
}));

import { addWebhook, listWebhooks, removeWebhook, testWebhooks } from "@/webhook-config";

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("listWebhooks", () => {
  it("returns empty array when no webhooks configured", async () => {
    const webhooks = await listWebhooks();
    expect(webhooks).toEqual([]);
  });
});

describe("addWebhook", () => {
  it("adds a new webhook", async () => {
    const entry = await addWebhook({ url: "https://example.com/hook" });
    expect(entry.url).toBe("https://example.com/hook");
    expect(entry.timeoutMs).toBe(5000);
    expect(entry.createdAt).toBeDefined();

    const webhooks = await listWebhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.url).toBe("https://example.com/hook");
  });

  it("deduplicates by URL", async () => {
    await addWebhook({ url: "https://example.com/hook" });
    await addWebhook({ url: "https://example.com/hook", timeoutMs: 10000 });

    const webhooks = await listWebhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.timeoutMs).toBe(10000);
  });

  it("supports optional events filter", async () => {
    await addWebhook({
      url: "https://example.com/hook",
      events: ["session:complete", "session:error"],
    });

    const webhooks = await listWebhooks();
    expect(webhooks[0]?.events).toEqual(["session:complete", "session:error"]);
  });

  it("validates URL format", async () => {
    await expect(addWebhook({ url: "not-a-url" })).rejects.toThrow();
  });
});

describe("removeWebhook", () => {
  it("removes an existing webhook", async () => {
    await addWebhook({ url: "https://example.com/hook" });
    const removed = await removeWebhook("https://example.com/hook");
    expect(removed).toBe(true);

    const webhooks = await listWebhooks();
    expect(webhooks).toHaveLength(0);
  });

  it("returns false when webhook not found", async () => {
    const removed = await removeWebhook("https://nonexistent.com/hook");
    expect(removed).toBe(false);
  });
});

describe("testWebhooks", () => {
  it("returns empty array when no webhooks configured", async () => {
    const results = await testWebhooks();
    expect(results).toEqual([]);
  });

  it("tests all configured webhooks", async () => {
    // Add a webhook to a non-existent endpoint
    await addWebhook({ url: "https://httpstat.us/200", timeoutMs: 1000 });

    const results = await testWebhooks();
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://httpstat.us/200");
    expect(results[0]?.durationMs).toBeGreaterThan(0);
  });

  it("handles connection failures gracefully", async () => {
    await addWebhook({ url: "https://localhost:59999/nonexistent", timeoutMs: 1000 });

    const results = await testWebhooks();
    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toBeDefined();
  });
});
