import type { MemoryEntry } from "./entry.js";

const SUBTYPE_ICONS: Record<string, string> = {
  fact: "·",
  procedure: "→",
};

/**
 * Format a list of memories for injection into an agent or supervisor prompt.
 * Groups by type, renders as concise markdown.
 */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";

  const knowledge = memories.filter((m) => m.type === "knowledge");
  const warnings = memories.filter((m) => m.type === "warning");
  const focus = memories.filter((m) => m.type === "focus");

  const sections: string[] = [];

  // Knowledge section (facts and procedures)
  if (knowledge.length > 0) {
    const facts = knowledge.filter((m) => m.subtype === "fact" || !m.subtype);
    const procedures = knowledge.filter((m) => m.subtype === "procedure");

    if (facts.length > 0) {
      const lines = facts.map((e) => {
        const confidence = e.accessCount >= 3 ? "" : " (unconfirmed)";
        const icon = SUBTYPE_ICONS.fact;
        return `${icon} ${e.content}${confidence}`;
      });
      sections.push(`### Facts\n${lines.join("\n")}`);
    }

    if (procedures.length > 0) {
      const lines = procedures.map((e) => {
        const confidence = e.accessCount >= 3 ? "" : " (unconfirmed)";
        const icon = SUBTYPE_ICONS.procedure;
        return `${icon} ${e.content}${confidence}`;
      });
      sections.push(`### How-tos\n${lines.join("\n")}`);
    }
  }

  // Warnings section (always injected, replaces old feedback type)
  if (warnings.length > 0) {
    const lines = warnings.map((e) => {
      const category = e.category ? `[${e.category}] ` : "";
      return `⚠ ${category}${e.content}`;
    });
    sections.push(`### Warnings\n${lines.join("\n")}`);
  }

  // Focus section (ephemeral working memory)
  if (focus.length > 0) {
    const lines = focus.map((e) => `★ ${e.content}`);
    sections.push(`### Current focus\n${lines.join("\n")}`);
  }

  return `## Known context for this repository\n\n${sections.join("\n\n")}`;
}
