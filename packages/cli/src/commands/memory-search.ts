import { getSupervisorDir, loadKnowledge, loadMemory } from "@neotx/core";
import { defineCommand } from "citty";

// ─── Types ───────────────────────────────────────────────

interface MemoryMatch {
  line: string;
  index: number;
}

interface KnowledgeMatch {
  line: string;
  section: string;
}

// ─── Helper Functions ────────────────────────────────────

function findMemoryMatches(lines: string[], query: string): MemoryMatch[] {
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.toLowerCase().includes(query));
}

function printMemoryMatchesShort(matches: MemoryMatch[]): void {
  console.log(`memory: ${matches.length} matches`);
  for (const { line } of matches) {
    console.log(`  ${line.trim()}`);
  }
}

function printMemoryMatchesFull(matches: MemoryMatch[], lines: string[]): void {
  console.log("## Memory matches\n");
  for (const { line, index } of matches) {
    if (index > 0) console.log(`  ${lines[index - 1]?.trim()}`);
    console.log(`> ${line.trim()}`);
    if (index < lines.length - 1) console.log(`  ${lines[index + 1]?.trim()}`);
    console.log();
  }
}

function findKnowledgeMatches(
  content: string,
  query: string,
  repoFilter: string | undefined,
): KnowledgeMatch[] {
  const lines = content.split("\n");
  const matches: KnowledgeMatch[] = [];
  let currentSection = "Global";

  for (const line of lines) {
    const headerMatch = /^##\s+(.+)$/.exec(line);
    if (headerMatch?.[1]) {
      currentSection = headerMatch[1].trim();
      continue;
    }

    if (repoFilter && !currentSection.includes(repoFilter)) continue;

    if (line.toLowerCase().includes(query)) {
      matches.push({ line: line.trim(), section: currentSection });
    }
  }

  return matches;
}

function printKnowledgeMatchesShort(matches: KnowledgeMatch[]): void {
  console.log(`knowledge: ${matches.length} matches`);
  for (const { line, section } of matches) {
    console.log(`  [${section}] ${line}`);
  }
}

function printKnowledgeMatchesFull(matches: KnowledgeMatch[]): void {
  console.log("## Knowledge matches\n");
  for (const { line, section } of matches) {
    console.log(`[${section}] ${line}`);
  }
}

// ─── Command ─────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "search",
    description: "Search across supervisor memory and knowledge",
  },
  args: {
    query: {
      type: "positional",
      description: "Search query",
      required: true,
    },
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: "supervisor",
    },
    repo: {
      type: "string",
      description: "Filter knowledge to a specific repo section",
    },
    short: {
      type: "boolean",
      description: "Compact output for agent consumption",
      default: false,
    },
  },
  async run({ args }) {
    const dir = getSupervisorDir(args.name);
    const query = (args.query as string).toLowerCase();
    const isShort = Boolean(args.short);

    let hasResults = false;

    // Search memory.json
    try {
      const raw = await loadMemory(dir);
      if (raw.trim()) {
        const lines = JSON.stringify(JSON.parse(raw), null, 2).split("\n");
        const matches = findMemoryMatches(lines, query);

        if (matches.length > 0) {
          hasResults = true;
          if (isShort) {
            printMemoryMatchesShort(matches);
          } else {
            printMemoryMatchesFull(matches, lines);
          }
        }
      }
    } catch {
      // No memory file
    }

    // Search knowledge.md
    try {
      const knowledge = await loadKnowledge(dir);
      if (knowledge.trim()) {
        const matches = findKnowledgeMatches(knowledge, query, args.repo as string | undefined);

        if (matches.length > 0) {
          hasResults = true;
          if (isShort) {
            printKnowledgeMatchesShort(matches);
          } else {
            printKnowledgeMatchesFull(matches);
          }
        }
      }
    } catch {
      // No knowledge file
    }

    if (!hasResults) {
      console.log(`No results for "${args.query}"`);
    }
  },
});
