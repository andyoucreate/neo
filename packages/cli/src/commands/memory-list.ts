import { getSupervisorDir, loadKnowledge, loadMemory, parseKnowledge, parseStructuredMemory } from "@neotx/core";
import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "list",
    description: "List memory and knowledge summary",
  },
  args: {
    name: {
      type: "string",
      description: "Supervisor instance name",
      default: "supervisor",
    },
  },
  async run({ args }) {
    const dir = getSupervisorDir(args.name);

    // Memory summary
    console.log("## Memory\n");
    try {
      const raw = await loadMemory(dir);
      if (raw.trim()) {
        const memory = parseStructuredMemory(raw);
        console.log(`  agenda: ${memory.agenda ? "set" : "(empty)"}`);
        console.log(`  activeWork: ${memory.activeWork.length} items`);
        console.log(`  blockers: ${memory.blockers.length} items`);
        console.log(`  decisions: ${memory.decisions.length} items`);
        console.log(`  trackerSync: ${Object.keys(memory.trackerSync).length} entries`);
      } else {
        console.log("  (empty)");
      }
    } catch {
      console.log("  (not initialized)");
    }

    // Knowledge summary
    console.log("\n## Knowledge\n");
    try {
      const knowledge = await loadKnowledge(dir);
      if (knowledge.trim()) {
        const sections = parseKnowledge(knowledge);
        for (const [section, facts] of sections) {
          console.log(`  ${section}: ${facts.length} facts`);
        }
        if (sections.size === 0) {
          console.log("  (empty)");
        }
      } else {
        console.log("  (empty)");
      }
    } catch {
      console.log("  (not initialized)");
    }
  },
});
