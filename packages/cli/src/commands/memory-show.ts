import { getSupervisorDir, loadKnowledge, loadMemory } from "@neotx/core";
import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "show",
    description: "Pretty-print full memory and knowledge",
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

    // Memory
    console.log("## Memory\n");
    try {
      const raw = await loadMemory(dir);
      if (raw.trim()) {
        console.log(JSON.stringify(JSON.parse(raw), null, 2));
      } else {
        console.log("(empty)");
      }
    } catch {
      console.log("(not initialized)");
    }

    // Knowledge
    console.log("\n## Knowledge\n");
    try {
      const knowledge = await loadKnowledge(dir);
      if (knowledge.trim()) {
        console.log(knowledge);
      } else {
        console.log("(empty)");
      }
    } catch {
      console.log("(not initialized)");
    }
  },
});
