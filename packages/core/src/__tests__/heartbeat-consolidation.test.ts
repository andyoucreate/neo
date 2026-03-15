import { describe, expect, it } from "vitest";
import { shouldConsolidate } from "@/supervisor/heartbeat";

describe("shouldConsolidate", () => {
  const interval = 5;

  it("returns true when heartbeats since last consolidation >= interval", () => {
    expect(shouldConsolidate(10, 5, interval, false)).toBe(true);
    expect(shouldConsolidate(15, 10, interval, false)).toBe(true);
  });

  it("returns false when heartbeats since last consolidation < interval and no pending entries", () => {
    expect(shouldConsolidate(7, 5, interval, false)).toBe(false);
    expect(shouldConsolidate(6, 5, interval, false)).toBe(false);
  });

  it("returns true when pending memory entries exist and since >= 2", () => {
    expect(shouldConsolidate(7, 5, interval, true)).toBe(true);
    expect(shouldConsolidate(3, 1, interval, true)).toBe(true);
  });

  it("returns false when pending memory entries exist but since < 2", () => {
    expect(shouldConsolidate(6, 5, interval, true)).toBe(false);
    expect(shouldConsolidate(1, 1, interval, true)).toBe(false);
  });

  it("returns true at exact interval boundary", () => {
    expect(shouldConsolidate(5, 0, interval, false)).toBe(true);
  });

  it("handles lastConsolidationHeartbeat of 0 (first run)", () => {
    // 3 heartbeats since 0, interval=5, no pending → false
    expect(shouldConsolidate(3, 0, interval, false)).toBe(false);
    // 5 heartbeats since 0, interval=5 → true
    expect(shouldConsolidate(5, 0, interval, false)).toBe(true);
    // 2 heartbeats since 0, pending → true
    expect(shouldConsolidate(2, 0, interval, true)).toBe(true);
  });

  it("works with consolidationInterval of 1", () => {
    expect(shouldConsolidate(1, 0, 1, false)).toBe(true);
    expect(shouldConsolidate(5, 4, 1, false)).toBe(true);
  });

  it("works with large consolidationInterval", () => {
    expect(shouldConsolidate(50, 0, 100, false)).toBe(false);
    expect(shouldConsolidate(100, 0, 100, false)).toBe(true);
    // Pending entries still trigger early at since >= 2
    expect(shouldConsolidate(2, 0, 100, true)).toBe(true);
  });
});
