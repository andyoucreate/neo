import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "neo",
    version: "0.1.0",
    description: "Orchestration framework for autonomous developer agents",
  },
  subCommands: {
    init: () => import("./commands/init.js").then((m) => m.default),
    run: () => import("./commands/run.js").then((m) => m.default),
    agents: () => import("./commands/agents.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
  },
});

runMain(main);
