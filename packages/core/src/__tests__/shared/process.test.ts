import { describe, expect, it } from "vitest";
import { isProcessAlive } from "@/shared/process";

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a non-existent PID", () => {
    // Use a high PID that is very unlikely to exist
    expect(isProcessAlive(999999)).toBe(false);
  });

  it("returns false for PID 0", () => {
    expect(isProcessAlive(0)).toBe(false);
  });

  it("returns false for negative PIDs", () => {
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(-999)).toBe(false);
  });

  it("returns false for NaN", () => {
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });

  it("returns false for non-integer PIDs", () => {
    expect(isProcessAlive(1.5)).toBe(false);
    expect(isProcessAlive(2.7)).toBe(false);
  });

  it("returns false for Infinity", () => {
    expect(isProcessAlive(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isProcessAlive(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});
