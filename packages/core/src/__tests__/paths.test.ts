import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getFocusedSupervisorDir,
  getFocusedSupervisorSessionPath,
  getFocusedSupervisorsDir,
  getWorkerStartedPath,
  toRepoSlug,
} from "@/paths";

describe("toRepoSlug", () => {
  it("uses name when present", () => {
    expect(toRepoSlug({ name: "my-project", path: "/some/other/path" })).toBe("my-project");
  });

  it("falls back to basename of path", () => {
    expect(toRepoSlug({ path: "/Users/karl/Documents/neo" })).toBe("neo");
  });

  it("lowercases the slug", () => {
    expect(toRepoSlug({ name: "MyProject", path: "/x" })).toBe("myproject");
  });

  it("replaces non-alphanumeric characters with hyphens", () => {
    expect(toRepoSlug({ path: "/home/user/My Cool Project!" })).toBe("my-cool-project");
    expect(toRepoSlug({ path: "/home/user/hello world" })).toBe("hello-world");
  });

  it("collapses consecutive hyphens", () => {
    expect(toRepoSlug({ name: "foo---bar", path: "/x" })).toBe("foo-bar");
  });

  it("strips leading and trailing hyphens", () => {
    expect(toRepoSlug({ name: "-foo-bar-", path: "/x" })).toBe("foo-bar");
  });

  it("preserves dots and underscores", () => {
    expect(toRepoSlug({ name: "my_project.v2", path: "/x" })).toBe("my_project.v2");
  });

  it("handles path with trailing slash", () => {
    expect(toRepoSlug({ path: "/Users/karl/neo/" })).toBe("neo");
  });

  it("uses undefined name as absent", () => {
    expect(toRepoSlug({ name: undefined, path: "/foo/bar" })).toBe("bar");
  });
});

describe("focused supervisor paths", () => {
  it("getFocusedSupervisorsDir returns ~/.neo/supervisors/focused", () => {
    const result = getFocusedSupervisorsDir();
    expect(result).toBe(path.join(homedir(), ".neo", "supervisors", "focused"));
  });

  it("getFocusedSupervisorDir returns ~/.neo/supervisors/focused/<id>", () => {
    const result = getFocusedSupervisorDir("sup_abc123");
    expect(result).toBe(path.join(homedir(), ".neo", "supervisors", "focused", "sup_abc123"));
  });

  it("getFocusedSupervisorSessionPath returns ~/.neo/supervisors/focused/<id>/session.json", () => {
    const result = getFocusedSupervisorSessionPath("sup_abc123");
    expect(result).toBe(
      path.join(homedir(), ".neo", "supervisors", "focused", "sup_abc123", "session.json"),
    );
  });
});

describe("worker startup paths", () => {
  it("getWorkerStartedPath returns ~/.neo/runs/<slug>/<runId>.started", () => {
    const result = getWorkerStartedPath("my-repo", "run-123");
    expect(result).toBe(path.join(homedir(), ".neo", "runs", "my-repo", "run-123.started"));
  });
});
