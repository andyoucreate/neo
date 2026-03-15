import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "neo",
    version: "0.1.0",
    description:
      "Orchestrate autonomous developer agents with worktree isolation, budget guards, and 3-level recovery. Run 'neo init' to get started.",
  },
  subCommands: {
    init: () => import("./commands/init.js").then((m) => m.default),
    run: () => import("./commands/run.js").then((m) => m.default),
    runs: () => import("./commands/runs.js").then((m) => m.default),
    log: () => import("./commands/log.js").then((m) => m.default),
    logs: () => import("./commands/logs.js").then((m) => m.default),
    cost: () => import("./commands/cost.js").then((m) => m.default),
    repos: () => import("./commands/repos.js").then((m) => m.default),
    agents: () => import("./commands/agents.js").then((m) => m.default),
    supervise: () => import("./commands/supervise.js").then((m) => m.default),
    mcp: () => import("./commands/mcp.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
    cleanup: () => import("./commands/cleanup.js").then((m) => m.default),
  },
});

runMain(main);
