import { parseArgs } from "node:util";
import { printError } from "./output.js";

const VERSION = "0.1.0";

const USAGE = `
neo — Orchestration framework for autonomous developer agents

Usage: neo <command> [options]

Commands:
  init      Initialize a .neo/ project directory
  run       Dispatch a workflow
  agents    List available agents
  doctor    Check environment prerequisites

Options:
  --help       Show help
  --version    Show version
  --output     Output format: json (default: human)
`.trim();

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      output: { type: "string", default: "human" },
      // init flags
      budget: { type: "string" },
      force: { type: "boolean", default: false },
      // run flags
      repo: { type: "string", default: "." },
      prompt: { type: "string" },
      priority: { type: "string" },
      meta: { type: "string" },
      config: { type: "string" },
    },
    strict: false,
  });

  const jsonOutput = values.output === "json";

  if (values.version) {
    console.log(VERSION);
    return;
  }

  const command = positionals[0];

  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "init": {
      const { runInit } = await import("./commands/init.js");
      await runInit({
        budget: values.budget ? Number(values.budget) : undefined,
        force: values.force as boolean,
      });
      break;
    }
    case "run": {
      const workflow = positionals[1];
      if (!workflow) {
        printError("Usage: neo run <workflow> --repo <path> --prompt <text>");
        process.exit(1);
      }
      if (!values.prompt) {
        printError("--prompt is required");
        process.exit(1);
      }
      const { runWorkflow } = await import("./commands/run.js");
      await runWorkflow({
        workflow,
        repo: values.repo as string,
        prompt: values.prompt as string,
        priority: values.priority as string | undefined,
        meta: values.meta as string | undefined,
        config: values.config as string | undefined,
        jsonOutput,
      });
      break;
    }
    case "agents": {
      const { runAgents } = await import("./commands/agents.js");
      await runAgents(jsonOutput);
      break;
    }
    case "doctor": {
      const { runDoctor } = await import("./commands/doctor.js");
      await runDoctor(jsonOutput);
      break;
    }
    default:
      printError(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((error) => {
  printError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
