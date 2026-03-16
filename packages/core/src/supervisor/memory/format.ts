import type { MemoryEntry } from "./entry.js";

const TYPE_LABELS: Record<string, string> = {
  fact: "Fact",
  procedure: "How-to",
  episode: "Past run",
  focus: "Current focus",
  feedback: "Recurring issue",
};

const TYPE_ICONS: Record<string, string> = {
  fact: "·",
  procedure: "→",
  episode: "◇",
  focus: "★",
  feedback: "⚠",
};

/**
 * Format a list of memories for injection into an agent or supervisor prompt.
 * Groups by type, renders as concise markdown.
 */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";

  const grouped = new Map<string, MemoryEntry[]>();
  for (const m of memories) {
    const group = grouped.get(m.type) ?? [];
    group.push(m);
    grouped.set(m.type, group);
  }

  const sections: string[] = [];

  for (const [type, entries] of grouped) {
    const label = TYPE_LABELS[type] ?? type;
    const icon = TYPE_ICONS[type] ?? "·";
    const lines = entries.map((e) => {
      const confidence = e.accessCount >= 3 ? "" : " (unconfirmed)";
      return `${icon} ${e.content}${confidence}`;
    });
    sections.push(`### ${label}s\n${lines.join("\n")}`);
  }

  return `## Known context for this repository\n\n${sections.join("\n\n")}`;
}
