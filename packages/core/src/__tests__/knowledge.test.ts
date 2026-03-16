import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadKnowledge } from "@/supervisor/knowledge";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_knowledge_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("loadKnowledge", () => {
  it("returns empty string when no files exist", async () => {
    const result = await loadKnowledge(TMP_DIR);
    expect(result).toBe("");
  });

  it("reads from knowledge.md", async () => {
    const md = "## Global\n- test fact\n";
    await writeFile(path.join(TMP_DIR, "knowledge.md"), md, "utf-8");
    const result = await loadKnowledge(TMP_DIR);
    expect(result).toBe(md);
  });

  it("prefers knowledge.md over knowledge.json", async () => {
    await writeFile(path.join(TMP_DIR, "knowledge.md"), "## Global\n- from md\n", "utf-8");
    await writeFile(path.join(TMP_DIR, "knowledge.json"), "from json", "utf-8");
    const result = await loadKnowledge(TMP_DIR);
    expect(result).toContain("from md");
    expect(result).not.toContain("from json");
  });
});
