import { getSupervisorDir, loadKnowledge, loadMemory } from "@neotx/core";
import { defineCommand } from "citty";
import { printError } from "../output.js";

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

    let hasResults = false;

    // Search memory.json
    try {
      const raw = await loadMemory(dir);
      if (raw.trim()) {
        const lines = JSON.stringify(JSON.parse(raw), null, 2).split("\n");
        const matches = lines
          .map((line, i) => ({ line, index: i }))
          .filter(({ line }) => line.toLowerCase().includes(query));

        if (matches.length > 0) {
          hasResults = true;
          if (args.short) {
            console.log(`memory: ${matches.length} matches`);
            for (const { line } of matches) {
              console.log(`  ${line.trim()}`);
            }
          } else {
            console.log("## Memory matches\n");
            for (const { line, index } of matches) {
              // Show context: 1 line before, match, 1 line after
              if (index > 0) console.log(`  ${lines[index - 1]?.trim()}`);
              console.log(`> ${line.trim()}`);
              if (index < lines.length - 1) console.log(`  ${lines[index + 1]?.trim()}`);
              console.log();
            }
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
        const lines = knowledge.split("\n");
        const matches: Array<{ line: string; section: string }> = [];
        let currentSection = "Global";

        for (const line of lines) {
          const headerMatch = /^##\s+(.+)$/.exec(line);
          if (headerMatch?.[1]) {
            currentSection = headerMatch[1].trim();
            continue;
          }

          // Filter by repo if specified
          if (args.repo && !currentSection.includes(args.repo as string)) continue;

          if (line.toLowerCase().includes(query)) {
            matches.push({ line: line.trim(), section: currentSection });
          }
        }

        if (matches.length > 0) {
          hasResults = true;
          if (args.short) {
            console.log(`knowledge: ${matches.length} matches`);
            for (const { line, section } of matches) {
              console.log(`  [${section}] ${line}`);
            }
          } else {
            console.log("## Knowledge matches\n");
            for (const { line, section } of matches) {
              console.log(`[${section}] ${line}`);
            }
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
