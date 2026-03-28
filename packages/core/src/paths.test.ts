import { describe, expect, it } from "vitest";
import { getSupervisorChildrenPath, getSupervisorDir } from "./paths.js";

describe("getSupervisorChildrenPath", () => {
  it("returns children.json inside supervisor dir", () => {
    const result = getSupervisorChildrenPath("my-supervisor");
    expect(result).toBe(`${getSupervisorDir("my-supervisor")}/children.json`);
  });

  it("ends with children.json", () => {
    expect(getSupervisorChildrenPath("foo")).toMatch(/\/children\.json$/);
  });
});
