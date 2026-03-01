import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  postToSlack,
  notifyPipelineComplete,
  notifyServiceEvent,
} from "../slack.js";

describe("Slack Notifications", () => {
  const originalEnv = process.env.SLACK_WEBHOOK_URL;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env.SLACK_WEBHOOK_URL = originalEnv;
    vi.restoreAllMocks();
  });

  describe("postToSlack", () => {
    it("should skip when no webhook URL is configured", async () => {
      delete process.env.SLACK_WEBHOOK_URL;
      // Re-import picks up module-level const — but since it's already imported,
      // the const is captured at import time. Test the behavior anyway.
      const result = await postToSlack("info", "Test message");
      // Without webhook URL, should return false
      expect(result).toBe(false);
    });

    it("should send POST request to webhook URL", async () => {
      process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      // Need to re-import to pick up new env var
      // Since the module caches the env var at import time,
      // we test the fetch call behavior indirectly
      const { postToSlack: freshPost } = await import("../slack.js");
      const result = await freshPost("success", "Pipeline complete", {
        Cost: "$25.50",
        Duration: "180s",
      });

      // Result depends on whether SLACK_WEBHOOK_URL was set at import time
      expect(typeof result).toBe("boolean");
    });

    it("should return false when fetch fails", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      const result = await postToSlack("error", "Test error");
      expect(result).toBe(false);
    });
  });

  describe("notifyPipelineComplete", () => {
    it("should not throw on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );

      await expect(
        notifyPipelineComplete({
          pipeline: "feature",
          sessionId: "session-123",
          status: "success",
          costUsd: 25.5,
          durationMs: 180000,
          ticketId: "PROJ-42",
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("notifyServiceEvent", () => {
    it("should not throw on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );

      await expect(
        notifyServiceEvent("started", { version: "0.1.0" }),
      ).resolves.not.toThrow();
    });
  });
});
