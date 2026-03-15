import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyKnowledgeOps,
  compactKnowledge,
  extractKnowledgeOps,
  isExpired,
  isTestData,
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

describe("applyKnowledgeOps with provenance", () => {
  it("includes runId in attribution when present", () => {
    const result = applyKnowledgeOps("", [
      {
        op: "append",
        section: "Global",
        fact: "API uses REST",
        source: "agent",
        runId: "run-123",
      },
    ]);
    expect(result).toContain("API uses REST [agent] (runId: run-123)");
  });

  it("includes confidence in attribution when present", () => {
    const result = applyKnowledgeOps("", [
      {
        op: "append",
        section: "Global",
        fact: "Uses PostgreSQL",
        source: "supervisor",
        confidence: 0.95,
      },
    ]);
    expect(result).toContain("Uses PostgreSQL [supervisor] (confidence: 0.95)");
  });

  it("includes expiresAt in attribution when present", () => {
    const result = applyKnowledgeOps("", [
      {
        op: "append",
        section: "Global",
        fact: "Temporary setting",
        source: "agent",
        expiresAt: "2026-04-01T00:00:00Z",
      },
    ]);
    expect(result).toContain("Temporary setting [agent] (expiresAt: 2026-04-01T00:00:00Z)");
  });

  it("includes all provenance fields when present", () => {
    const result = applyKnowledgeOps("", [
      {
        op: "append",
        section: "Global",
        fact: "Full provenance fact",
        source: "agent",
        date: "2026-03-15",
        runId: "run-abc",
        confidence: 0.8,
        expiresAt: "2026-06-15T00:00:00Z",
      },
    ]);
    expect(result).toContain("[agent, 2026-03-15]");
    expect(result).toContain("runId: run-abc");
    expect(result).toContain("confidence: 0.8");
    expect(result).toContain("expiresAt: 2026-06-15T00:00:00Z");
  });

  it("handles append without any provenance (backwards compatible)", () => {
    const result = applyKnowledgeOps("", [
      { op: "append", section: "Global", fact: "Simple fact" },
    ]);
    expect(result).toContain("- Simple fact\n");
    expect(result).not.toContain("[");
  });
});

describe("isExpired", () => {
  it("returns false for facts without expiresAt", () => {
    expect(isExpired("Simple fact [agent, 2026-03-15]")).toBe(false);
    expect(isExpired("No expiration")).toBe(false);
  });

  it("returns true for expired facts", () => {
    // Use a date in the past
    const pastDate = "2020-01-01T00:00:00Z";
    expect(isExpired(`Expired fact [agent] (expiresAt: ${pastDate})`)).toBe(true);
  });

  it("returns false for facts with future expiresAt", () => {
    const futureDate = "2099-12-31T23:59:59Z";
    expect(isExpired(`Future fact [agent] (expiresAt: ${futureDate})`)).toBe(false);
  });

  it("handles expiresAt with other provenance fields", () => {
    const pastDate = "2020-01-01";
    expect(isExpired(`Fact [agent] (runId: abc, expiresAt: ${pastDate}, confidence: 0.9)`)).toBe(
      true,
    );
  });
});

describe("isTestData", () => {
  it("returns true for facts with [test] source", () => {
    expect(isTestData("Some fact [test]")).toBe(true);
    expect(isTestData("Some fact [test, 2026-03-15]")).toBe(true);
  });

  it("returns true for facts with test as second attribute", () => {
    expect(isTestData("Some fact [agent, test]")).toBe(true);
  });

  it("returns true for facts with test data keywords", () => {
    expect(isTestData("Uses test-data for development")).toBe(true);
    expect(isTestData("mock_data in fixtures")).toBe(true);
    expect(isTestData("fixture used for testing")).toBe(true);
    expect(isTestData("__test__ helper")).toBe(true);
    expect(isTestData("spec-helper utilities")).toBe(true);
  });

  it("returns false for normal facts", () => {
    expect(isTestData("Uses PostgreSQL [agent, 2026-03-15]")).toBe(false);
    expect(isTestData("Production ready")).toBe(false);
  });
});

describe("compactKnowledge with cleanup", () => {
  it("removes expired facts during compaction", () => {
    const md = `## Global
- Valid fact [agent, 2026-03-15]
- Expired fact [agent] (expiresAt: 2020-01-01T00:00:00Z)
- Another valid fact [supervisor]
`;
    const result = compactKnowledge(md);
    expect(result).toContain("Valid fact");
    expect(result).toContain("Another valid fact");
    expect(result).not.toContain("Expired fact");
  });

  it("removes test data facts during compaction", () => {
    const md = `## Global
- Production fact [agent]
- Test data fixture [test]
- Real config [supervisor]
`;
    const result = compactKnowledge(md);
    expect(result).toContain("Production fact");
    expect(result).toContain("Real config");
    expect(result).not.toContain("Test data fixture");
  });

  it("removes section when all facts are filtered", () => {
    const md = `## TestSection
- test-data helper [test]
- mock_data fixture [test]

## Production
- Real fact [agent]
`;
    const result = compactKnowledge(md);
    const sections = parseKnowledge(result);
    expect(sections.has("TestSection")).toBe(false);
    expect(sections.has("Production")).toBe(true);
  });

  it("still trims to maxFactsPerRepo after filtering", () => {
    const facts = Array.from({ length: 25 }, (_, i) => `- Fact ${i} [agent]`).join("\n");
    const md = `## Global\n${facts}\n`;
    const result = compactKnowledge(md, 20);
    const sections = parseKnowledge(result);
    expect(sections.get("Global")).toHaveLength(20);
    // Should keep last 20 (Fact 5 through Fact 24)
    expect(sections.get("Global")?.[0]).toContain("Fact 5");
  });

  it("returns empty string when all facts are filtered", () => {
    const md = `## OnlyTest
- test-data [test]
`;
    const result = compactKnowledge(md);
    expect(result).toBe("");
  });
});
