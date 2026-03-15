import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeOp } from "./schemas.js";
import { knowledgeOpSchema } from "./schemas.js";

const KNOWLEDGE_MD = "knowledge.md";
const KNOWLEDGE_JSON = "knowledge.json";

/**
 * Load knowledge from disk. Migrates from knowledge.json if needed.
 */
export async function loadKnowledge(dir: string): Promise<string> {
  // Try markdown first
  try {
    return await readFile(path.join(dir, KNOWLEDGE_MD), "utf-8");
  } catch {
    // Not found — try migration from JSON
  }

  // Migrate from knowledge.json
  try {
    const raw = await readFile(path.join(dir, KNOWLEDGE_JSON), "utf-8");
    if (raw.trim()) {
      const md = migrateFromJson(raw);
      await writeFile(path.join(dir, KNOWLEDGE_MD), md, "utf-8");
      return md;
    }
  } catch {
    // No legacy file either
  }

  return "";
}

/**
 * Save knowledge to disk as markdown.
 */
export async function saveKnowledge(dir: string, content: string): Promise<void> {
  await writeFile(path.join(dir, KNOWLEDGE_MD), content, "utf-8");
}

/**
 * Parse knowledge markdown into a section→facts map.
 */
export function parseKnowledge(md: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  if (!md.trim()) return sections;

  let currentSection = "Global";
  const facts: string[] = [];

  for (const line of md.split("\n")) {
    const headerMatch = /^##\s+(.+)$/.exec(line);
    const headerValue = headerMatch?.[1];
    if (headerValue) {
      // Save previous section if it had facts
      if (facts.length > 0) {
        sections.set(currentSection, [...facts]);
        facts.length = 0;
      }
      currentSection = headerValue.trim();
      continue;
    }

    const factMatch = /^-\s+(.+)$/.exec(line);
    const factValue = factMatch?.[1];
    if (factValue) {
      facts.push(factValue.trim());
    }
  }

  // Save last section
  if (facts.length > 0) {
    sections.set(currentSection, facts);
  }

  return sections;
}

/**
 * Render a section→facts map back to markdown.
 */
export function renderKnowledge(sections: Map<string, string[]>): string {
  const parts: string[] = [];

  for (const [section, facts] of sections) {
    if (facts.length === 0) continue;
    parts.push(`## ${section}`);
    for (const fact of facts) {
      parts.push(`- ${fact}`);
    }
    parts.push("");
  }

  return `${parts.join("\n").trim()}\n`;
}

/**
 * Extract knowledge operations from Claude's response.
 */
export function extractKnowledgeOps(response: string): KnowledgeOp[] {
  const match = /<knowledge-ops>([\s\S]*?)<\/knowledge-ops>/i.exec(response);
  if (!match?.[1]) return [];
  const ops: KnowledgeOp[] = [];
  for (const line of match[1].trim().split("\n").filter(Boolean)) {
    try {
      ops.push(knowledgeOpSchema.parse(JSON.parse(line)));
    } catch {}
  }
  return ops;
}

/**
 * Format a fact with provenance attribution when present.
 * Format: 'fact [source, date]' or 'fact [source] (runId: X, confidence: Y, expiresAt: Z)'
 */
function formatFactWithProvenance(op: Extract<KnowledgeOp, { op: "append" }>): string {
  const basicAttrs = [op.source, op.date].filter(Boolean);
  const provenanceAttrs: string[] = [];

  if (op.runId) {
    provenanceAttrs.push(`runId: ${op.runId}`);
  }
  if (op.confidence !== undefined) {
    provenanceAttrs.push(`confidence: ${op.confidence}`);
  }
  if (op.expiresAt) {
    provenanceAttrs.push(`expiresAt: ${op.expiresAt}`);
  }

  const basicAttr = basicAttrs.join(", ");
  const provenanceAttr = provenanceAttrs.length > 0 ? ` (${provenanceAttrs.join(", ")})` : "";

  if (basicAttr || provenanceAttr) {
    return `${op.fact} [${basicAttr}]${provenanceAttr}`;
  }
  return op.fact;
}

/**
 * Apply knowledge operations to markdown content.
 */
export function applyKnowledgeOps(md: string, ops: KnowledgeOp[]): string {
  const sections = parseKnowledge(md);

  for (const op of ops) {
    switch (op.op) {
      case "append": {
        const existing = sections.get(op.section) ?? [];
        const fact = formatFactWithProvenance(op);
        existing.push(fact);
        sections.set(op.section, existing);
        break;
      }
      case "remove": {
        const existing = sections.get(op.section);
        if (existing && op.index >= 0 && op.index < existing.length) {
          existing.splice(op.index, 1);
          if (existing.length === 0) {
            sections.delete(op.section);
          }
        }
        break;
      }
    }
  }

  return sections.size > 0 ? renderKnowledge(sections) : "";
}

/**
 * Select only knowledge sections relevant to the given repo paths.
 * Always includes "Global" section.
 */
export function selectKnowledgeForRepos(md: string, repoPaths: string[]): string {
  if (!md.trim()) return "";
  const sections = parseKnowledge(md);
  const filtered = new Map<string, string[]>();

  for (const [section, facts] of sections) {
    if (section === "Global") {
      filtered.set(section, facts);
      continue;
    }
    // Match if any repo path is a prefix/suffix of the section name
    for (const repo of repoPaths) {
      if (section.includes(repo) || repo.includes(section)) {
        filtered.set(section, facts);
        break;
      }
    }
  }

  return filtered.size > 0 ? renderKnowledge(filtered) : "";
}

/**
 * Check if a fact has expired based on its expiresAt provenance field.
 * Looks for pattern: (expiresAt: YYYY-MM-DD...) in the fact string.
 */
export function isExpired(fact: string): boolean {
  const expiresMatch = /\(.*?expiresAt:\s*(\d{4}-\d{2}-\d{2}[T\d:.-Z]*).*?\)/.exec(fact);
  if (!expiresMatch?.[1]) return false;

  const expiresAt = new Date(expiresMatch[1]).getTime();
  if (Number.isNaN(expiresAt)) return false;

  return Date.now() > expiresAt;
}

/**
 * Check if a fact is test/mock data that should be filtered during compaction.
 * Detects sourceType='test' or common test data patterns.
 */
export function isTestData(fact: string): boolean {
  // Check for explicit test sourceType in attribution
  if (/\[test[,\]]/.test(fact) || /\[.*?,\s*test\]/.test(fact)) {
    return true;
  }

  // Check for test data keywords in the fact content
  const testPatterns = [
    /\btest[-_]?data\b/i,
    /\bmock[-_]?data\b/i,
    /\bfixture\b/i,
    /\b__test__\b/i,
    /\bspec[-_]?helper\b/i,
  ];

  return testPatterns.some((pattern) => pattern.test(fact));
}

/**
 * Compact knowledge by trimming oldest facts per section.
 * Also filters out expired facts and test data.
 * Returns the compacted markdown string.
 */
export function compactKnowledge(md: string, maxFactsPerRepo = 20): string {
  if (!md.trim()) return "";
  const sections = parseKnowledge(md);

  for (const [section, facts] of sections) {
    // Filter out expired and test data facts
    const filtered = facts.filter((fact) => !isExpired(fact) && !isTestData(fact));

    if (filtered.length > maxFactsPerRepo) {
      // Keep the most recent facts (last N)
      sections.set(section, filtered.slice(-maxFactsPerRepo));
    } else if (filtered.length === 0) {
      sections.delete(section);
    } else {
      sections.set(section, filtered);
    }
  }

  return sections.size > 0 ? renderKnowledge(sections) : "";
}

/**
 * Add staleness markers to facts older than the given threshold.
 * Facts with a date attribution `[source, YYYY-MM-DD]` are checked.
 */
export function markStaleFacts(md: string, staleDays = 30): string {
  if (!md.trim()) return md;
  const now = Date.now();
  const thresholdMs = staleDays * 24 * 60 * 60 * 1000;

  return md.replace(
    /^- (.+?)( \[([^\]]+)\])$/gm,
    (_match, fact: string, attr: string, attrContent: string) => {
      // Extract date from attribution like [source, 2026-03-01]
      const dateMatch = /\d{4}-\d{2}-\d{2}/.exec(attrContent);
      if (!dateMatch) return `- ${fact}${attr}`;

      const factDate = new Date(dateMatch[0]).getTime();
      if (Number.isNaN(factDate)) return `- ${fact}${attr}`;

      if (now - factDate > thresholdMs && !fact.includes("(stale?)")) {
        return `- ${fact} (stale?)${attr}`;
      }
      return `- ${fact}${attr}`;
    },
  );
}

/**
 * Migrate from knowledge.json to knowledge.md format.
 */
function migrateFromJson(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // JSON object — wrap each key/value as a section/bullet
    const sections = new Map<string, string[]>();
    for (const [key, value] of Object.entries(parsed)) {
      const facts = sections.get("Legacy") ?? [];
      facts.push(`${key}: ${String(value)}`);
      sections.set("Legacy", facts);
    }
    return renderKnowledge(sections);
  } catch {
    // Plain text — put in Legacy section
    const lines = raw.trim().split("\n").filter(Boolean);
    const facts = lines.map((line) => line.replace(/^-\s*/, ""));
    if (facts.length === 0) return "";
    const sections = new Map<string, string[]>();
    sections.set("Legacy", facts);
    return renderKnowledge(sections);
  }
}
