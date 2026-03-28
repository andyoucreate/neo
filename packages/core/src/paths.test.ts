import { describe, expect, it } from "vitest";
import {
  getChildSupervisorDir,
  getChildSupervisorHeartbeatPath,
  getChildSupervisorStatePath,
  getChildSupervisorsDir,
  getSupervisorChildrenPath,
  getSupervisorDir,
} from "./paths.js";

describe("getSupervisorChildrenPath", () => {
  it("returns children.json inside supervisor dir", () => {
    const result = getSupervisorChildrenPath("my-supervisor");
    expect(result).toBe(`${getSupervisorDir("my-supervisor")}/children.json`);
  });

  it("ends with children.json", () => {
    expect(getSupervisorChildrenPath("foo")).toMatch(/\/children\.json$/);
  });
});

describe("child supervisor paths", () => {
  it("getChildSupervisorsDir returns correct path", () => {
    const result = getChildSupervisorsDir("supervisor");
    expect(result).toContain(".neo/supervisors/supervisor/children");
  });

  it("getChildSupervisorDir returns correct path for child", () => {
    const result = getChildSupervisorDir("supervisor", "cleanup-neo");
    expect(result).toContain(".neo/supervisors/supervisor/children/cleanup-neo");
  });

  it("getChildSupervisorStatePath returns state.json path", () => {
    const result = getChildSupervisorStatePath("supervisor", "cleanup-neo");
    expect(result).toMatch(/children\/cleanup-neo\/state\.json$/);
  });

  it("getChildSupervisorHeartbeatPath returns heartbeat.json path", () => {
    const result = getChildSupervisorHeartbeatPath("supervisor", "cleanup-neo");
    expect(result).toMatch(/children\/cleanup-neo\/heartbeat\.json$/);
  });
});
