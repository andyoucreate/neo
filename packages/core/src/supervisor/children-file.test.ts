import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChildrenFile, writeChildrenFile } from "./children-file.js";
import type { ChildHandle } from "./schemas.js";

const TMP = path.join(import.meta.dirname, "__tmp_children_test__");

const makeHandle = (id: string): ChildHandle => ({
  supervisorId: id,
  objective: `Objective for ${id}`,
  depth: 0,
  startedAt: new Date().toISOString(),
  lastProgressAt: new Date().toISOString(),
  costUsd: 0,
  status: "running",
});

describe("writeChildrenFile / readChildrenFile", () => {
  beforeEach(() => mkdir(TMP, { recursive: true }));
  afterEach(() => rm(TMP, { recursive: true, force: true }));

  it("returns empty array when file does not exist", async () => {
    const result = await readChildrenFile(path.join(TMP, "children.json"));
    expect(result).toEqual([]);
  });

  it("round-trips an array of handles", async () => {
    const filePath = path.join(TMP, "children.json");
    const handles = [makeHandle("abc"), makeHandle("def")];
    await writeChildrenFile(filePath, handles);
    const result = await readChildrenFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]?.supervisorId).toBe("abc");
    expect(result[1]?.supervisorId).toBe("def");
  });

  it("overwrites on second write", async () => {
    const filePath = path.join(TMP, "children.json");
    await writeChildrenFile(filePath, [makeHandle("a")]);
    await writeChildrenFile(filePath, [makeHandle("b"), makeHandle("c")]);
    const result = await readChildrenFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]?.supervisorId).toBe("b");
  });

  it("returns empty array on malformed JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    const filePath = path.join(TMP, "children.json");
    await writeFile(filePath, "not json", "utf-8");
    const result = await readChildrenFile(filePath);
    expect(result).toEqual([]);
  });
});
