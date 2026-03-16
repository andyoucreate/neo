import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldCompact, shouldConsolidate } from "@/supervisor/heartbeat";

describe("shouldConsolidate", () => {
  const FIVE_MINUTES_MS = 300_000;
  const MIN_GRACE_MS = 30_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when interval has elapsed", () => {
    const lastConsolidation = new Date(Date.now() - FIVE_MINUTES_MS).toISOString();
    expect(shouldConsolidate(lastConsolidation, FIVE_MINUTES_MS, false)).toBe(true);
  });

  it("returns false when interval has not elapsed and no pending entries", () => {
    const lastConsolidation = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    expect(shouldConsolidate(lastConsolidation, FIVE_MINUTES_MS, false)).toBe(false);
  });

  it("returns true when pending entries exist and grace period has passed", () => {
    const lastConsolidation = new Date(Date.now() - MIN_GRACE_MS).toISOString();
    expect(shouldConsolidate(lastConsolidation, FIVE_MINUTES_MS, true)).toBe(true);
  });

  it("returns false when pending entries exist but grace period has not passed", () => {
    const lastConsolidation = new Date(Date.now() - 10_000).toISOString(); // 10s ago
    expect(shouldConsolidate(lastConsolidation, FIVE_MINUTES_MS, true)).toBe(false);
  });

  it("handles first run (no last consolidation timestamp)", () => {
    // First run with no pending entries → false (nothing to consolidate)
    expect(shouldConsolidate(undefined, FIVE_MINUTES_MS, false)).toBe(false);
    // First run with pending entries → true
    expect(shouldConsolidate(undefined, FIVE_MINUTES_MS, true)).toBe(true);
  });

  it("returns true at exact interval boundary", () => {
    const lastConsolidation = new Date(Date.now() - FIVE_MINUTES_MS).toISOString();
    expect(shouldConsolidate(lastConsolidation, FIVE_MINUTES_MS, false)).toBe(true);
  });

  it("works with short interval", () => {
    const ONE_MINUTE_MS = 60_000;
    const lastConsolidation = new Date(Date.now() - ONE_MINUTE_MS).toISOString();
    expect(shouldConsolidate(lastConsolidation, ONE_MINUTE_MS, false)).toBe(true);
  });

  it("works with large interval", () => {
    const ONE_HOUR_MS = 3_600_000;
    // 30 minutes ago → not enough time elapsed
    const lastConsolidation = new Date(Date.now() - 1_800_000).toISOString();
    expect(shouldConsolidate(lastConsolidation, ONE_HOUR_MS, false)).toBe(false);
    // But with pending entries and grace period passed → true
    expect(shouldConsolidate(lastConsolidation, ONE_HOUR_MS, true)).toBe(true);
  });
});

describe("shouldCompact", () => {
  const ONE_HOUR_MS = 3_600_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when interval has elapsed", () => {
    const lastCompaction = new Date(Date.now() - ONE_HOUR_MS).toISOString();
    expect(shouldCompact(lastCompaction, ONE_HOUR_MS)).toBe(true);
  });

  it("returns false when interval has not elapsed", () => {
    const lastCompaction = new Date(Date.now() - 1_800_000).toISOString(); // 30 min ago
    expect(shouldCompact(lastCompaction, ONE_HOUR_MS)).toBe(false);
  });

  it("returns false on first run (no last compaction timestamp)", () => {
    // First compaction should wait for the interval
    expect(shouldCompact(undefined, ONE_HOUR_MS)).toBe(false);
  });

  it("returns true at exact interval boundary", () => {
    const lastCompaction = new Date(Date.now() - ONE_HOUR_MS).toISOString();
    expect(shouldCompact(lastCompaction, ONE_HOUR_MS)).toBe(true);
  });
});
