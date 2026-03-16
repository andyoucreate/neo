import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFocus } from "@/supervisor/focus";

function makeTmpDir(): string {
  const dir = path.join(
    tmpdir(),
    `focus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadFocus", () => {
  const dirs: string[] = [];

  afterEach(() => {
    // Cleanup is best-effort — tmp dirs will be cleaned by OS
  });

  it("returns empty string when focus.md does not exist", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const result = await loadFocus(dir);
    expect(result).toBe("");
  });

  it("returns file content when focus.md exists", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const content = "Working on auth deploy.\nWaiting for run abc123.\n";
    writeFileSync(path.join(dir, "focus.md"), content, "utf-8");

    const result = await loadFocus(dir);
    expect(result).toBe(content);
  });

  it("returns empty string when directory does not exist", async () => {
    const result = await loadFocus("/nonexistent/path/that/does/not/exist");
    expect(result).toBe("");
  });
});
