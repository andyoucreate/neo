import path from "node:path";
import type { Embedder, MemoryEntry, MemoryType } from "@neotx/core";
import { getSupervisorDir, LocalEmbedder, MemoryStore } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess, printTable } from "../output.js";

const VALID_TYPES = ["fact", "procedure", "episode", "focus", "feedback", "task"] as const;

interface ParsedArgs {
  value: string | undefined;
  type: string | undefined;
  scope: string;
  source: string;
  expires: string | undefined;
  name: string;
  outcome: string | undefined;
  severity: string | undefined;
  category: string | undefined;
  tags: string | undefined;
}

function parseDuration(input: string): string | undefined {
  const match = input.match(/^(\d+)(h|m)$/);
  if (!match) return undefined;

  const value = Number(match[1]);
  const unit = match[2];
  const ms = unit === "h" ? value * 60 * 60 * 1000 : value * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function createEmbedder(): Embedder | null {
  try {
    return new LocalEmbedder();
  } catch {
    // Embeddings optional — gracefully degrade if model loading fails
    return null;
  }
}

function openStore(name: string, withEmbeddings = false): MemoryStore {
  const dir = getSupervisorDir(name);
  const embedder = withEmbeddings ? createEmbedder() : null;
  return new MemoryStore(path.join(dir, "memory.sqlite"), embedder);
}

function formatResultsTable(results: MemoryEntry[]): void {
  printTable(
    ["ID", "TYPE", "SCOPE", "CONTENT", "ACCESSES"],
    results.map((m) => [m.id, m.type, m.scope, truncate(m.content, 60), String(m.accessCount)]),
  );
}

async function handleWrite(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo memory write <content> --type <type> [--scope <scope>]");
    process.exitCode = 1;
    return;
  }

  const type = args.type ?? "fact";
  if (!VALID_TYPES.includes(type as MemoryType)) {
    printError(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  let expiresAt: string | undefined;
  if (args.expires) {
    expiresAt = parseDuration(args.expires);
    if (!expiresAt) {
      printError('Invalid --expires format. Use e.g. "2h" or "30m".');
      process.exitCode = 1;
      return;
    }
  }

  const store = openStore(args.name, true);
  try {
    const tags = args.tags ? args.tags.split(",").map((t) => t.trim()) : [];
    const id = await store.write({
      type: type as MemoryType,
      scope: args.scope,
      content: args.value,
      source: args.source,
      tags,
      expiresAt,
      severity: args.severity,
      category: args.category,
      outcome: args.outcome,
    });
    printSuccess(`Memory written: ${id}`);
  } finally {
    store.close();
  }
}

function handleForget(args: ParsedArgs): void {
  if (!args.value) {
    printError("Usage: neo memory forget <id>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    store.forget(args.value);
    printSuccess(`Memory forgotten: ${args.value}`);
  } finally {
    store.close();
  }
}

const VALID_OUTCOMES = ["pending", "in_progress", "done", "blocked", "abandoned"] as const;

function handleUpdate(args: ParsedArgs): void {
  if (!args.value) {
    printError('Usage: neo memory update <id> ["new content"] [--outcome <status>]');
    process.exitCode = 1;
    return;
  }

  // The ID is in value, but we need content too.
  // citty only supports 2 positional args — content comes after ID.
  const argv = process.argv;
  const updateIdx = argv.indexOf("update");
  const idArg = argv[updateIdx + 1];
  const contentArg = argv[updateIdx + 2];

  // Validate outcome if provided
  if (args.outcome && !VALID_OUTCOMES.includes(args.outcome as (typeof VALID_OUTCOMES)[number])) {
    printError(`Invalid outcome "${args.outcome}". Must be one of: ${VALID_OUTCOMES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Determine if contentArg is actually content or a flag
  const isContentArgAFlag = contentArg?.startsWith("--");
  const hasContent = contentArg && !isContentArgAFlag;

  // Need either content or --outcome
  if (!hasContent && !args.outcome) {
    printError('Usage: neo memory update <id> ["new content"] [--outcome <status>]');
    process.exitCode = 1;
    return;
  }

  // ID is required at this point — validated by args.value check above
  if (!idArg) {
    printError('Usage: neo memory update <id> ["new content"] [--outcome <status>]');
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    // Use updateFields when --outcome is provided
    if (args.outcome) {
      store.updateFields(idArg, {
        ...(hasContent && { content: contentArg }),
        outcome: args.outcome,
      });
    } else {
      // contentArg is guaranteed to be defined when hasContent is true and no outcome
      store.update(idArg, contentArg as string);
    }
    printSuccess(`Memory updated: ${idArg}`);
  } finally {
    store.close();
  }
}

async function handleSearch(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo memory search <query>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name, true);
  try {
    const results = await store.search(args.value, {
      ...(args.scope !== "global" && { scope: args.scope }),
      ...(args.type && { types: [args.type as MemoryType] }),
    });

    if (results.length === 0) {
      console.log("No memories found.");
      return;
    }

    formatResultsTable(results);
  } finally {
    store.close();
  }
}

function handleList(args: ParsedArgs): void {
  const store = openStore(args.name);
  try {
    const results = store.query({
      ...(args.scope !== "global" && { scope: args.scope }),
      ...(args.type && { types: [args.type as MemoryType] }),
    });

    if (results.length === 0) {
      console.log("No memories found.");
      return;
    }

    formatResultsTable(results);
  } finally {
    store.close();
  }
}

function handleStats(args: ParsedArgs): void {
  const store = openStore(args.name);
  try {
    const s = store.stats();
    console.log(`Total memories: ${s.total}\n`);

    if (Object.keys(s.byType).length > 0) {
      printTable(
        ["TYPE", "COUNT"],
        Object.entries(s.byType).map(([t, c]) => [t, String(c)]),
      );
      console.log();
    }

    if (Object.keys(s.byScope).length > 0) {
      printTable(
        ["SCOPE", "COUNT"],
        Object.entries(s.byScope).map(([sc, c]) => [sc, String(c)]),
      );
    }
  } finally {
    store.close();
  }
}

export default defineCommand({
  meta: {
    name: "memory",
    description: "Manage the supervisor memory store",
  },
  args: {
    action: {
      type: "positional",
      description: "Action: write, forget, update, search, list, stats",
      required: true,
    },
    value: {
      type: "positional",
      description: "Content or ID depending on action",
      required: false,
    },
    type: {
      type: "string",
      description: "Memory type: fact, procedure, episode, focus, feedback, task",
    },
    scope: {
      type: "string",
      description: "Scope: global or repo path",
      default: "global",
    },
    source: {
      type: "string",
      description: "Source: developer, reviewer, supervisor, user",
      default: "user",
    },
    expires: {
      type: "string",
      description: "TTL for focus entries (e.g. 2h, 30m)",
    },
    outcome: {
      type: "string",
      description: "Task outcome: pending, in_progress, done, blocked, abandoned",
    },
    severity: {
      type: "string",
      description: "Priority: critical, high, medium, low",
    },
    category: {
      type: "string",
      description: "Context reference (e.g. 'neo runs abc123' or 'cat notes/plan.md')",
    },
    tags: {
      type: "string",
      description: "Comma-separated tags (e.g. 'initiative:auth,depends:mem_abc')",
    },
    name: {
      type: "string",
      description: "Supervisor name",
      default: "supervisor",
    },
  },
  async run({ args }) {
    const action = args.action as string;
    const parsed: ParsedArgs = {
      value: args.value as string | undefined,
      type: args.type as string | undefined,
      scope: args.scope as string,
      source: args.source as string,
      expires: args.expires as string | undefined,
      name: args.name as string,
      outcome: args.outcome as string | undefined,
      severity: args.severity as string | undefined,
      category: args.category as string | undefined,
      tags: args.tags as string | undefined,
    };

    switch (action) {
      case "write":
        return handleWrite(parsed);
      case "forget":
        return handleForget(parsed);
      case "update":
        return handleUpdate(parsed);
      case "search":
        return handleSearch(parsed);
      case "list":
        return handleList(parsed);
      case "stats":
        return handleStats(parsed);
      default:
        printError(
          `Unknown action "${action}". Must be one of: write, forget, update, search, list, stats`,
        );
        process.exitCode = 1;
    }
  },
});
