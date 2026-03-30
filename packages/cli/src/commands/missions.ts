import { getSupervisorDir, type MissionStatus, MissionStore } from "@neotx/core";
import { defineCommand } from "citty";
import { printError } from "../output.js";

const DEFAULT_SUPERVISOR = "supervisor";

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all missions",
  },
  args: {
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
    status: {
      type: "string",
      description: "Filter by status (pending, in_progress, completed, failed)",
    },
    limit: {
      type: "string",
      description: "Max number of missions to show",
      default: "20",
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const limit = Number.parseInt(args.limit, 10);
    const status = args.status as MissionStatus | undefined;

    const missions = await store.listMissions(status ? { status, limit } : { limit });

    if (missions.length === 0) {
      console.log("No missions found.");
      return;
    }

    console.log(`\nMissions (${missions.length}):\n`);
    for (const mission of missions) {
      const statusIcon = {
        pending: "⏳",
        in_progress: "🔄",
        blocked: "🚫",
        completed: "✅",
        failed: "❌",
        cancelled: "⛔",
      }[mission.status];

      console.log(`  ${statusIcon} ${mission.missionId}`);
      console.log(`     Status: ${mission.status}`);
      console.log(`     Cost: $${mission.costUsd.toFixed(2)}`);
      console.log(`     Started: ${mission.startedAt}`);
      if (mission.runIds.length > 0) {
        console.log(`     Runs: ${mission.runIds.length}`);
      }
      console.log("");
    }
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show details of a specific mission",
  },
  args: {
    missionId: {
      type: "positional",
      description: "Mission ID to show",
      required: true,
    },
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const mission = await store.getMission(args.missionId);

    if (!mission) {
      printError(`Mission not found: ${args.missionId}`);
      process.exitCode = 1;
      return;
    }

    console.log(`\nMission: ${mission.missionId}\n`);
    console.log(`  Run ID:    ${mission.id}`);
    console.log(`  Status:    ${mission.status}`);
    console.log(`  Profile:   ${mission.supervisorProfile}`);
    console.log(`  Cost:      $${mission.costUsd.toFixed(2)}`);
    console.log(`  Started:   ${mission.startedAt}`);
    if (mission.completedAt) {
      console.log(`  Completed: ${mission.completedAt}`);
    }
    if (mission.runIds.length > 0) {
      console.log(`  Agent Runs:`);
      for (const runId of mission.runIds) {
        console.log(`    - ${runId}`);
      }
    }
    if (mission.evidence?.length) {
      console.log(`  Evidence:`);
      for (const e of mission.evidence) {
        console.log(`    ✓ ${e}`);
      }
    }
    if (mission.failureReason) {
      console.log(`  Failure: ${mission.failureReason}`);
    }
    console.log("");
  },
});

const treeCommand = defineCommand({
  meta: {
    name: "tree",
    description: "Show mission hierarchy as a tree",
  },
  args: {
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const missions = await store.listMissions();

    if (missions.length === 0) {
      console.log("No missions found.");
      return;
    }

    console.log("\nMission Tree:\n");

    // Group by status for tree view
    const byStatus = new Map<string, typeof missions>();
    for (const m of missions) {
      const list = byStatus.get(m.status) ?? [];
      list.push(m);
      byStatus.set(m.status, list);
    }

    for (const [status, list] of byStatus) {
      console.log(`  ${status.toUpperCase()} (${list.length})`);
      for (const m of list) {
        console.log(`    └─ ${m.missionId} ($${m.costUsd.toFixed(2)})`);
        for (const runId of m.runIds) {
          console.log(`       └─ ${runId}`);
        }
      }
      console.log("");
    }
  },
});

const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description: "Show logs for a mission",
  },
  args: {
    missionId: {
      type: "positional",
      description: "Mission ID",
      required: true,
    },
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    // For now, redirect to activity log filtered by mission
    console.log(`Logs for mission ${args.missionId}:`);
    console.log("  (Activity log integration pending)");
    console.log(`  View full logs: neo supervisor activity --filter ${args.missionId}`);
  },
});

const debugCommand = defineCommand({
  meta: {
    name: "debug",
    description: "Debug information for a mission",
  },
  args: {
    missionId: {
      type: "positional",
      description: "Mission ID",
      required: true,
    },
    supervisor: {
      type: "string",
      alias: "s",
      description: "Supervisor name",
      default: DEFAULT_SUPERVISOR,
    },
  },
  async run({ args }) {
    const supervisorDir = getSupervisorDir(args.supervisor);
    const store = new MissionStore(supervisorDir);

    const mission = await store.getMission(args.missionId);

    if (!mission) {
      printError(`Mission not found: ${args.missionId}`);
      process.exitCode = 1;
      return;
    }

    console.log("\nMission Debug Info:\n");
    console.log(JSON.stringify(mission, null, 2));
  },
});

export default defineCommand({
  meta: {
    name: "missions",
    description: "Manage missions",
  },
  subCommands: {
    list: () => Promise.resolve(listCommand),
    show: () => Promise.resolve(showCommand),
    tree: () => Promise.resolve(treeCommand),
    logs: () => Promise.resolve(logsCommand),
    debug: () => Promise.resolve(debugCommand),
  },
});
