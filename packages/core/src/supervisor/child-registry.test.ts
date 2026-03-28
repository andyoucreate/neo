import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChildRegistry } from "./child-registry.js";

describe("ChildRegistry — children.json persistence", () => {
  const TMP = path.join(import.meta.dirname, "__tmp_registry_children__");
  const childrenPath = path.join(TMP, "children.json");

  beforeEach(() => mkdir(TMP, { recursive: true }));
  afterEach(() => rm(TMP, { recursive: true, force: true }));

  it("writes children.json on register", async () => {
    const registry = new ChildRegistry({ onMessage: () => {}, childrenFilePath: childrenPath });
    registry.register({
      supervisorId: "s1",
      objective: "do something",
      depth: 0,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      status: "running",
    });
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(childrenPath, "utf-8");
    const parsed = JSON.parse(raw) as { supervisorId: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.supervisorId).toBe("s1");
  });

  it("writes children.json on remove", async () => {
    const registry = new ChildRegistry({ onMessage: () => {}, childrenFilePath: childrenPath });
    registry.register({
      supervisorId: "s2",
      objective: "do something",
      depth: 0,
      startedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      costUsd: 0,
      status: "running",
    });
    await new Promise((r) => setTimeout(r, 50));
    registry.remove("s2");
    await new Promise((r) => setTimeout(r, 50));
    const raw = await readFile(childrenPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown[];
    expect(parsed).toHaveLength(0);
  });
});
