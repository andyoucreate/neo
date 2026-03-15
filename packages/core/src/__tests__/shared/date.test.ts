import { describe, expect, it } from "vitest";
import { fileForDate, toDateKey } from "@/shared/date";

describe("toDateKey", () => {
  it("returns YYYY-MM-DD format", () => {
    const date = new Date("2026-03-14T10:00:00Z");
    expect(toDateKey(date)).toBe("2026-03-14");
  });

  it("handles single-digit months with leading zero", () => {
    const date = new Date("2026-01-05T12:00:00Z");
    expect(toDateKey(date)).toBe("2026-01-05");
  });

  it("handles single-digit days with leading zero", () => {
    const date = new Date("2026-03-01T08:00:00Z");
    expect(toDateKey(date)).toBe("2026-03-01");
  });

  it("returns consistent UTC date regardless of input timezone offset", () => {
    // Midnight UTC on March 14th
    const utcMidnight = new Date("2026-03-14T00:00:00Z");
    expect(toDateKey(utcMidnight)).toBe("2026-03-14");

    // Late evening UTC on March 14th
    const utcLateEvening = new Date("2026-03-14T23:59:59Z");
    expect(toDateKey(utcLateEvening)).toBe("2026-03-14");
  });

  it("handles timezone edge case: late night in positive offset becomes next day UTC", () => {
    // 11 PM in UTC+2 is 9 PM UTC (same day)
    // But 2 AM in UTC+2 is midnight UTC (same day)
    // This tests that toISOString always uses UTC
    const date = new Date("2026-03-14T23:00:00.000Z");
    expect(toDateKey(date)).toBe("2026-03-14");
  });

  it("handles timezone edge case: early morning UTC stays same day", () => {
    // 1 AM UTC is still March 14th
    const date = new Date("2026-03-14T01:00:00Z");
    expect(toDateKey(date)).toBe("2026-03-14");
  });

  it("handles year boundary", () => {
    const newYearsEve = new Date("2025-12-31T23:59:59Z");
    expect(toDateKey(newYearsEve)).toBe("2025-12-31");

    const newYearsDay = new Date("2026-01-01T00:00:00Z");
    expect(toDateKey(newYearsDay)).toBe("2026-01-01");
  });

  it("handles leap year date", () => {
    const leapDay = new Date("2024-02-29T12:00:00Z");
    expect(toDateKey(leapDay)).toBe("2024-02-29");
  });

  it("handles month boundary", () => {
    const endOfMonth = new Date("2026-03-31T23:59:59Z");
    expect(toDateKey(endOfMonth)).toBe("2026-03-31");

    const startOfNextMonth = new Date("2026-04-01T00:00:00Z");
    expect(toDateKey(startOfNextMonth)).toBe("2026-04-01");
  });
});

describe("fileForDate", () => {
  it("generates correct file path with prefix and directory", () => {
    const date = new Date("2026-03-14T10:00:00Z");
    expect(fileForDate(date, "cost", "/data")).toBe("/data/cost-2026-03.jsonl");
  });

  it("handles different prefixes", () => {
    const date = new Date("2026-03-14T10:00:00Z");
    expect(fileForDate(date, "events", "/logs")).toBe("/logs/events-2026-03.jsonl");
    expect(fileForDate(date, "metrics", "/var/data")).toBe("/var/data/metrics-2026-03.jsonl");
  });

  it("pads single-digit months with leading zero", () => {
    const date = new Date("2026-01-15T12:00:00Z");
    expect(fileForDate(date, "cost", "/data")).toBe("/data/cost-2026-01.jsonl");
  });

  it("handles December correctly (month 12)", () => {
    const date = new Date("2026-12-25T12:00:00Z");
    expect(fileForDate(date, "cost", "/data")).toBe("/data/cost-2026-12.jsonl");
  });

  it("uses UTC month to avoid timezone boundary issues", () => {
    // 11:30 PM UTC on March 31st
    // In UTC+2, this would be 1:30 AM on April 1st
    // But we should still get March file since we use UTC
    const date = new Date("2026-03-31T23:30:00Z");
    expect(fileForDate(date, "cost", "/data")).toBe("/data/cost-2026-03.jsonl");
  });

  it("handles timezone edge case: start of month UTC", () => {
    // Exactly midnight UTC on April 1st
    const date = new Date("2026-04-01T00:00:00Z");
    expect(fileForDate(date, "cost", "/data")).toBe("/data/cost-2026-04.jsonl");
  });

  it("handles year boundary correctly", () => {
    const endOfYear = new Date("2025-12-31T23:59:59Z");
    expect(fileForDate(endOfYear, "cost", "/data")).toBe("/data/cost-2025-12.jsonl");

    const startOfYear = new Date("2026-01-01T00:00:00Z");
    expect(fileForDate(startOfYear, "cost", "/data")).toBe("/data/cost-2026-01.jsonl");
  });

  it("handles relative directory paths", () => {
    const date = new Date("2026-03-14T10:00:00Z");
    expect(fileForDate(date, "cost", "./data")).toBe("data/cost-2026-03.jsonl");
    expect(fileForDate(date, "cost", "../logs")).toBe("../logs/cost-2026-03.jsonl");
  });

  it("handles empty directory (current directory)", () => {
    const date = new Date("2026-03-14T10:00:00Z");
    expect(fileForDate(date, "cost", ".")).toBe("cost-2026-03.jsonl");
  });

  it("handles nested directory paths", () => {
    const date = new Date("2026-03-14T10:00:00Z");
    expect(fileForDate(date, "cost", "/var/lib/neo/journals")).toBe(
      "/var/lib/neo/journals/cost-2026-03.jsonl",
    );
  });
});
