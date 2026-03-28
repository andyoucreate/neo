import { defineCommand } from "citty";
import { spawnChildFromCli } from "../child-mode.js";
import { isDaemonRunning } from "../daemon-utils.js";
import { printError } from "../output.js";

const DEFAULT_SUPERVISOR = "supervisor";

const spawnCommand = defineCommand({
  meta: {
    name: "spawn",
    description: "Request a supervisor to spawn a child supervisor",
  },
  args: {
    supervisor: {
      type: "string",
      alias: "s",
      description: "Name of the parent supervisor (default: supervisor)",
      default: DEFAULT_SUPERVISOR,
    },
    objective: {
      type: "string",
      alias: "o",
      description: "Objective for the child supervisor",
      required: true,
    },
    criteria: {
      type: "string",
      alias: "c",
      description: "Comma-separated acceptance criteria",
      required: true,
    },
    budget: {
      type: "string",
      alias: "b",
      description: "Max cost in USD for the child supervisor",
    },
  },
  async run({ args }) {
    const supervisorName = args.supervisor;
    const objective = args.objective;
    const criteriaStr = args.criteria;
    const budgetStr = args.budget;

    // Validate supervisor is running
    const running = await isDaemonRunning(supervisorName);
    if (!running) {
      printError(`Supervisor "${supervisorName}" is not running.`);
      printError("Start it first with: neo supervise --detach");
      process.exitCode = 1;
      return;
    }

    // Parse criteria
    const criteria = criteriaStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (criteria.length === 0) {
      printError("At least one acceptance criterion is required.");
      process.exitCode = 1;
      return;
    }

    // Parse budget
    const budget = budgetStr ? Number.parseFloat(budgetStr) : undefined;
    if (
      budgetStr !== undefined &&
      (Number.isNaN(budget) || (budget !== undefined && budget <= 0))
    ) {
      printError("Budget must be a positive number.");
      process.exitCode = 1;
      return;
    }

    // Send spawn request to supervisor
    const options: Parameters<typeof spawnChildFromCli>[0] = {
      parentName: supervisorName,
      objective,
      acceptanceCriteria: criteria,
    };
    if (budget !== undefined) {
      options.maxCostUsd = budget;
    }
    await spawnChildFromCli(options);
  },
});

export default defineCommand({
  meta: {
    name: "child",
    description: "Manage child supervisors",
  },
  subCommands: {
    spawn: () => Promise.resolve(spawnCommand),
  },
});
