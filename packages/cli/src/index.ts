import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "neo",
    version: "0.1.0",
    description:
      "Orchestrate autonomous developer agents with clone isolation, budget guards, and 3-level recovery. Run 'neo init' to get started.",
  },
  subCommands: {
    init: () => import("./commands/init.js").then((m) => m.default),
    run: () => import("./commands/run.js").then((m) => m.default),
    do: () => import("./commands/do.js").then((m) => m.default),
    decision: () => import("./commands/decision.js").then((m) => m.default),
    runs: () => import("./commands/runs.js").then((m) => m.default),
    log: () => import("./commands/log.js").then((m) => m.default),
    logs: () => import("./commands/logs.js").then((m) => m.default),
    cost: () => import("./commands/cost.js").then((m) => m.default),
    config: () => import("./commands/config.js").then((m) => m.default),
    repos: () => import("./commands/repos.js").then((m) => m.default),
    agents: () => import("./commands/agents.js").then((m) => m.default),
    supervise: () => import("./commands/supervise.js").then((m) => m.default),
    supervisor: () => import("./commands/supervisor/index.js").then((m) => m.default),
    memory: () => import("./commands/memory.js").then((m) => m.default),
    mcp: () => import("./commands/mcp.js").then((m) => m.default),
    guide: () => import("./commands/guide.js").then((m) => m.default),
    health: () => import("./commands/health.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
    version: () => import("./commands/version.js").then((m) => m.default),
    webhooks: () => import("./commands/webhooks.js").then((m) => m.default),
  },
});

runMain(main);
