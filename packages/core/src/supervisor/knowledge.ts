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
 * Apply knowledge operations to markdown content.
 */
export function applyKnowledgeOps(md: string, ops: KnowledgeOp[]): string {
  const sections = parseKnowledge(md);

  for (const op of ops) {
    switch (op.op) {
      case "append": {
        const existing = sections.get(op.section) ?? [];
        const attribution = [op.source, op.date].filter(Boolean).join(", ");
        const fact = attribution ? `${op.fact} [${attribution}]` : op.fact;
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
 * Compact knowledge by trimming oldest facts per section.
 * Returns the compacted markdown string.
 */
export function compactKnowledge(md: string, maxFactsPerRepo = 20): string {
  if (!md.trim()) return "";
  const sections = parseKnowledge(md);

  for (const [section, facts] of sections) {
    if (facts.length > maxFactsPerRepo) {
      // Keep the most recent facts (last N)
      sections.set(section, facts.slice(-maxFactsPerRepo));
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
