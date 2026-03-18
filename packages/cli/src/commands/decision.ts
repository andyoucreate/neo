import path from "node:path";
import { type DecisionOption, DecisionStore, getSupervisorDir } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess, printTable } from "../output.js";

const DEFAULT_EXPIRES_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ParsedArgs {
  action: string;
  question: string | undefined;
  options: string | undefined;
  defaultAnswer: string | undefined;
  expiresIn: string | undefined;
  type: string | undefined;
  context: string | undefined;
  name: string;
  id: string | undefined;
  answer: string | undefined;
}

function parseDurationMs(input: string): number | undefined {
  const match = input.match(/^(\d+)(h|m|d)$/);
  if (!match) return undefined;

  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    default:
      return undefined;
  }
}

function parseOptions(optionsArg: string): DecisionOption[] | undefined {
  // Format: "key1:label1,key2:label2" or "key1:label1:description1,key2:label2:description2"
  if (!optionsArg.trim()) return undefined;

  const options: DecisionOption[] = [];
  const parts = optionsArg.split(",");

  for (const part of parts) {
    const segments = part.trim().split(":");
    const key = segments[0];
    const label = segments[1];
    if (!key || !label) {
      throw new Error(
        `Invalid option format: "${part}". Expected "key:label" or "key:label:description"`,
      );
    }
    const descParts = segments.slice(2);
    options.push({
      key: key.trim(),
      label: label.trim(),
      description: descParts.length > 0 ? descParts.join(":").trim() : undefined,
    });
  }

  return options.length > 0 ? options : undefined;
}

function openStore(supervisorName: string): DecisionStore {
  const dir = getSupervisorDir(supervisorName);
  return new DecisionStore(path.join(dir, "decisions.jsonl"));
}

async function handleCreate(args: ParsedArgs): Promise<void> {
  if (!args.question) {
    printError(
      "Usage: neo decision create <question> --options 'key1:label1,key2:label2' [--default <key>] [--expires-in 24h]",
    );
    process.exitCode = 1;
    return;
  }

  let options: DecisionOption[] | undefined;
  if (args.options) {
    try {
      options = parseOptions(args.options);
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  let expiresAt: string | undefined;
  if (args.expiresIn) {
    const ms = parseDurationMs(args.expiresIn);
    if (!ms) {
      printError('Invalid --expires-in format. Use e.g. "24h", "30m", or "7d".');
      process.exitCode = 1;
      return;
    }
    expiresAt = new Date(Date.now() + ms).toISOString();
  } else {
    // Default to 24 hours
    expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_MS).toISOString();
  }

  const store = openStore(args.name);
  try {
    const id = await store.create({
      question: args.question,
      options,
      defaultAnswer: args.defaultAnswer,
      expiresAt,
      type: args.type ?? "generic",
      source: "supervisor",
      context: args.context,
    });
    printSuccess(`Decision created: ${id}`);
    console.log(id); // Output just the ID for easy parsing in scripts
  } catch (error) {
    printError(
      `Failed to create decision: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function handleList(args: ParsedArgs): Promise<void> {
  const store = openStore(args.name);
  try {
    const pending = await store.pending();

    if (pending.length === 0) {
      console.log("No pending decisions.");
      return;
    }

    printTable(
      ["ID", "QUESTION", "OPTIONS", "EXPIRES"],
      pending.map((d) => [
        d.id,
        d.question.length > 40 ? `${d.question.slice(0, 37)}...` : d.question,
        d.options?.map((o) => o.key).join(", ") ?? "(free-form)",
        d.expiresAt ? new Date(d.expiresAt).toLocaleString() : "never",
      ]),
    );
  } catch (error) {
    printError(
      `Failed to list decisions: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function handleAnswer(args: ParsedArgs): Promise<void> {
  if (!args.id || !args.answer) {
    printError("Usage: neo decision answer <id> <answer>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    await store.answer(args.id, args.answer);
    printSuccess(`Decision answered: ${args.id} -> ${args.answer}`);
  } catch (error) {
    printError(
      `Failed to answer decision: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function handleGet(args: ParsedArgs): Promise<void> {
  if (!args.id) {
    printError("Usage: neo decision get <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    const decision = await store.get(args.id);
    if (!decision) {
      printError(`Decision not found: ${args.id}`);
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify(decision, null, 2));
  } catch (error) {
    printError(`Failed to get decision: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export default defineCommand({
  meta: {
    name: "decision",
    description: "Manage supervisor decisions requiring human input",
  },
  args: {
    action: {
      type: "positional",
      description: "Action: create, list, answer, get",
      required: true,
    },
    question: {
      type: "positional",
      description: "Question text (for create) or ID (for answer/get)",
      required: false,
    },
    answer: {
      type: "positional",
      description: "Answer value (for answer action)",
      required: false,
    },
    options: {
      type: "string",
      alias: "o",
      description:
        'Options in format "key1:label1,key2:label2" or "key1:label1:desc1,key2:label2:desc2"',
    },
    "default-answer": {
      type: "string",
      alias: "d",
      description: "Default answer key (used if decision expires)",
    },
    "expires-in": {
      type: "string",
      alias: "e",
      description: "Expiration duration (e.g. 24h, 30m, 7d). Default: 24h",
    },
    type: {
      type: "string",
      alias: "t",
      description: "Decision type (default: generic)",
    },
    context: {
      type: "string",
      alias: "c",
      description: "Additional context for the decision",
    },
    name: {
      type: "string",
      description: "Supervisor name",
      default: "supervisor",
    },
  },
  async run({ args }) {
    const action = args.action as string;

    // Map positional args based on action
    let id: string | undefined;
    let questionOrId: string | undefined = args.question as string | undefined;
    const answerArg: string | undefined = args.answer as string | undefined;

    // For answer/get actions, the "question" positional is actually the ID
    if (action === "answer" || action === "get") {
      id = questionOrId;
      questionOrId = undefined;
    }

    const parsed: ParsedArgs = {
      action,
      question: questionOrId,
      options: args.options as string | undefined,
      defaultAnswer: args["default-answer"] as string | undefined,
      expiresIn: args["expires-in"] as string | undefined,
      type: args.type as string | undefined,
      context: args.context as string | undefined,
      name: args.name as string,
      id,
      answer: answerArg,
    };

    switch (action) {
      case "create":
        return handleCreate(parsed);
      case "list":
        return handleList(parsed);
      case "answer":
        return handleAnswer(parsed);
      case "get":
        return handleGet(parsed);
      default:
        printError(`Unknown action "${action}". Must be one of: create, list, answer, get`);
        process.exitCode = 1;
    }
  },
});
