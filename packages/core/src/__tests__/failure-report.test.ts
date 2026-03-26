import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSuggestedAction,
  classifyError,
  createFailureReport,
  writeFailureReport,
} from "@/supervisor/failure-report";
import type { FailureReport } from "@/supervisor/schemas";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_failure_report_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("writeFailureReport", () => {
  it("writes structured failure report to inbox.jsonl", async () => {
    const report: Omit<FailureReport, "timestamp"> = {
      type: "failure-report",
      runId: "run_abc123",
      task: "Implement auth middleware",
      reason: "Module not found: @auth/jwt",
      attemptCount: 3,
      lastErrorType: "spawn_error",
      suggestedAction: "Check that @auth/jwt is installed",
      costUsd: 0.43,
    };

    await writeFailureReport(TMP_DIR, report);

    const content = await readFile(path.join(TMP_DIR, "inbox.jsonl"), "utf-8");
    const parsed = JSON.parse(content.trim());

    expect(parsed.type).toBe("failure-report");
    expect(parsed.runId).toBe("run_abc123");
    expect(parsed.attemptCount).toBe(3);
    expect(parsed.timestamp).toBeDefined();
  });
});

describe("classifyError", () => {
  it("classifies timeout errors", () => {
    expect(classifyError("Operation timed out after 30s")).toBe("timeout");
  });

  it("classifies budget errors", () => {
    expect(classifyError("Budget exceeded: $5.00 limit")).toBe("budget");
  });

  it("classifies spawn errors", () => {
    expect(classifyError("Module not found: lodash")).toBe("spawn_error");
  });

  it("classifies recovery exhausted", () => {
    expect(classifyError("Max retries exceeded")).toBe("recovery_exhausted");
  });

  it("defaults to unknown", () => {
    expect(classifyError("Something weird happened")).toBe("unknown");
  });
});

describe("buildSuggestedAction", () => {
  it("suggests recovery for spawn_error", () => {
    const action = buildSuggestedAction("spawn_error", "Module not found");
    expect(action).toContain("dependencies");
  });

  it("suggests budget review for budget error", () => {
    const action = buildSuggestedAction("budget", "Budget exceeded");
    expect(action).toContain("budget");
  });

  it("suggests fresh session for recovery_exhausted", () => {
    const action = buildSuggestedAction("recovery_exhausted", "Max retries");
    expect(action).toContain("fresh session");
  });

  it("suggests timeout increase for timeout", () => {
    const action = buildSuggestedAction("timeout", "Operation timed out");
    expect(action).toContain("timeout");
  });
});

describe("createFailureReport", () => {
  it("creates a complete failure report", () => {
    const report = createFailureReport({
      runId: "run_xyz",
      task: "Deploy to prod",
      reason: "Connection timed out",
      attemptCount: 2,
      costUsd: 1.23,
    });

    expect(report.type).toBe("failure-report");
    expect(report.runId).toBe("run_xyz");
    expect(report.lastErrorType).toBe("timeout");
    expect(report.suggestedAction).toContain("timeout");
  });
});
