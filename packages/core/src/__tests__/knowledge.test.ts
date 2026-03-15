import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyKnowledgeOps,
  extractKnowledgeOps,
  loadKnowledge,
  parseKnowledge,
  renderKnowledge,
  saveKnowledge,
  selectKnowledgeForRepos,
} from "@/supervisor/knowledge";

const TMP_DIR = path.join(import.meta.dirname, "__tmp_knowledge_test__");

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("parseKnowledge", () => {
  it("returns empty map for empty string", () => {
    expect(parseKnowledge("").size).toBe(0);
    expect(parseKnowledge("  ").size).toBe(0);
  });

  it("parses sections with facts", () => {
    const md = `## /repos/myapp
- Uses Prisma with PostgreSQL [developer, 2026-03-15]
- CI takes ~8 min [supervisor, 2026-03-14]

## Global
- All repos use pnpm workspaces [supervisor, 2026-03-15]
`;
    const sections = parseKnowledge(md);
    expect(sections.size).toBe(2);
    expect(sections.get("/repos/myapp")).toHaveLength(2);
    expect(sections.get("Global")).toHaveLength(1);
  });

  it("puts facts without headers in Global section", () => {
    const md = `- Fact one
- Fact two
`;
    const sections = parseKnowledge(md);
    expect(sections.get("Global")).toHaveLength(2);
  });
});

describe("renderKnowledge", () => {
  it("renders sections back to markdown", () => {
    const sections = new Map<string, string[]>();
    sections.set("/repos/myapp", ["Uses Prisma [dev, 2026-03-15]"]);
    sections.set("Global", ["pnpm workspaces"]);
    const md = renderKnowledge(sections);
    expect(md).toContain("## /repos/myapp");
    expect(md).toContain("- Uses Prisma [dev, 2026-03-15]");
    expect(md).toContain("## Global");
    expect(md).toContain("- pnpm workspaces");
  });

  it("skips empty sections", () => {
    const sections = new Map<string, string[]>();
    sections.set("Empty", []);
    sections.set("Full", ["fact"]);
    const md = renderKnowledge(sections);
    expect(md).not.toContain("## Empty");
    expect(md).toContain("## Full");
  });
});

describe("parseKnowledge + renderKnowledge roundtrip", () => {
  it("roundtrips correctly", () => {
    const original = `## /repos/myapp
- Uses Prisma [dev, 2026-03-15]

## Global
- pnpm workspaces
`;
    const sections = parseKnowledge(original);
    const rendered = renderKnowledge(sections);
    const reparsed = parseKnowledge(rendered);
    expect(reparsed.get("/repos/myapp")).toEqual(sections.get("/repos/myapp"));
    expect(reparsed.get("Global")).toEqual(sections.get("Global"));
  });
});

describe("extractKnowledgeOps", () => {
  it("extracts valid ops from response", () => {
    const response = `Some text
<knowledge-ops>
{"op":"append","section":"Global","fact":"New fact","source":"supervisor","date":"2026-03-15"}
{"op":"remove","section":"/repos/myapp","index":0}
</knowledge-ops>
More text`;
    const ops = extractKnowledgeOps(response);
    expect(ops).toHaveLength(2);
    expect(ops[0]?.op).toBe("append");
    expect(ops[1]?.op).toBe("remove");
  });

  it("returns empty array when no block found", () => {
    expect(extractKnowledgeOps("no ops here")).toEqual([]);
  });

  it("skips malformed lines", () => {
    const response = `<knowledge-ops>
{"op":"append","section":"Global","fact":"ok"}
not json
{"invalid":"schema"}
</knowledge-ops>`;
    const ops = extractKnowledgeOps(response);
    expect(ops).toHaveLength(1);
  });
});

describe("applyKnowledgeOps", () => {
  const baseMd = `## /repos/myapp
- Uses Prisma [dev, 2026-03-15]
- CI takes 8 min [supervisor, 2026-03-14]

## Global
- pnpm workspaces [supervisor, 2026-03-15]
`;

  it("appends a fact to existing section", () => {
    const result = applyKnowledgeOps(baseMd, [
      {
        op: "append",
        section: "/repos/myapp",
        fact: "Uses Redis",
        source: "developer",
        date: "2026-03-15",
      },
    ]);
    expect(result).toContain("- Uses Redis [developer, 2026-03-15]");
    expect(parseKnowledge(result).get("/repos/myapp")).toHaveLength(3);
  });

  it("appends a fact to new section", () => {
    const result = applyKnowledgeOps(baseMd, [
      { op: "append", section: "/repos/api", fact: "NestJS backend" },
    ]);
    expect(result).toContain("## /repos/api");
    expect(result).toContain("- NestJS backend");
  });

  it("removes a fact by index", () => {
    const result = applyKnowledgeOps(baseMd, [{ op: "remove", section: "/repos/myapp", index: 0 }]);
    const sections = parseKnowledge(result);
    expect(sections.get("/repos/myapp")).toHaveLength(1);
    expect(sections.get("/repos/myapp")?.[0]).toContain("CI takes");
  });

  it("removes last fact deletes section", () => {
    const result = applyKnowledgeOps(baseMd, [{ op: "remove", section: "Global", index: 0 }]);
    expect(parseKnowledge(result).has("Global")).toBe(false);
  });

  it("returns empty string when all sections removed", () => {
    const simple = `## Only
- Single fact
`;
    const result = applyKnowledgeOps(simple, [{ op: "remove", section: "Only", index: 0 }]);
    expect(result).toBe("");
  });

  it("ignores remove with invalid index", () => {
    const result = applyKnowledgeOps(baseMd, [{ op: "remove", section: "Global", index: 99 }]);
    expect(parseKnowledge(result).get("Global")).toHaveLength(1);
  });
});

describe("selectKnowledgeForRepos", () => {
  const md = `## /repos/myapp
- Uses Prisma [dev, 2026-03-15]

## /repos/api
- NestJS [dev, 2026-03-15]

## Global
- pnpm workspaces [supervisor, 2026-03-15]
`;

  it("selects matching repos + Global", () => {
    const result = selectKnowledgeForRepos(md, ["/repos/myapp"]);
    const sections = parseKnowledge(result);
    expect(sections.has("/repos/myapp")).toBe(true);
    expect(sections.has("Global")).toBe(true);
    expect(sections.has("/repos/api")).toBe(false);
  });

  it("returns empty for no matches (still includes Global)", () => {
    const result = selectKnowledgeForRepos(md, ["/repos/unknown"]);
    const sections = parseKnowledge(result);
    expect(sections.has("Global")).toBe(true);
    expect(sections.size).toBe(1);
  });

  it("returns empty string for empty input", () => {
    expect(selectKnowledgeForRepos("", ["/repos/myapp"])).toBe("");
  });
});

describe("loadKnowledge / saveKnowledge", () => {
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

  it("migrates from knowledge.json (JSON object)", async () => {
    await writeFile(
      path.join(TMP_DIR, "knowledge.json"),
      JSON.stringify({ db: "postgres", cache: "redis" }),
      "utf-8",
    );
    const result = await loadKnowledge(TMP_DIR);
    expect(result).toContain("## Legacy");
    expect(result).toContain("db: postgres");
    expect(result).toContain("cache: redis");
    // Should have created knowledge.md
    const mdOnDisk = await readFile(path.join(TMP_DIR, "knowledge.md"), "utf-8");
    expect(mdOnDisk).toBe(result);
  });

  it("migrates from knowledge.json (plain text)", async () => {
    await writeFile(path.join(TMP_DIR, "knowledge.json"), "Uses postgres\nUses redis\n", "utf-8");
    const result = await loadKnowledge(TMP_DIR);
    expect(result).toContain("## Legacy");
    expect(result).toContain("Uses postgres");
  });

  it("prefers knowledge.md over knowledge.json", async () => {
    await writeFile(path.join(TMP_DIR, "knowledge.md"), "## Global\n- from md\n", "utf-8");
    await writeFile(path.join(TMP_DIR, "knowledge.json"), "from json", "utf-8");
    const result = await loadKnowledge(TMP_DIR);
    expect(result).toContain("from md");
    expect(result).not.toContain("from json");
  });

  it("saves and loads roundtrip", async () => {
    const md = "## Global\n- saved fact\n";
    await saveKnowledge(TMP_DIR, md);
    const loaded = await loadKnowledge(TMP_DIR);
    expect(loaded).toBe(md);
  });
});
