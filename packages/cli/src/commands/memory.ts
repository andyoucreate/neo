import path from "node:path";
import type { Embedder, KnowledgeSubtype, MemoryEntry, MemoryType } from "@neotx/core";
import { getSupervisorDir, LocalEmbedder, MemoryStore } from "@neotx/core";
import { defineCommand } from "citty";
import { printError, printSuccess, printTable } from "../output.js";

const VALID_TYPES = ["knowledge", "warning", "focus"] as const;
const VALID_SUBTYPES = ["fact", "procedure"] as const;

interface ParsedArgs {
  value: string | undefined;
  type: string | undefined;
  subtype: string | undefined;
  scope: string;
  source: string;
  expires: string | undefined;
  name: string;
  category: string | undefined;
  tags: string | undefined;
  full: boolean;
  limit: string | undefined;
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
  } catch (err) {
    // Embedder initialization failed — semantic search will be unavailable
    console.debug(
      `[memory] Failed to create embedder: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function openStore(name: string, withEmbeddings = false): MemoryStore {
  const dir = getSupervisorDir(name);
  const embedder = withEmbeddings ? createEmbedder() : null;
  return new MemoryStore(path.join(dir, "memory.sqlite"), embedder);
}

function formatResultsTable(results: MemoryEntry[], full = false): void {
  const maxContent = full ? 500 : 60;
  printTable(
    ["ID", "TYPE", "SCOPE", "CONTENT", "ACCESSES"],
    results.map((m) => [
      m.id,
      m.type,
      m.scope,
      truncate(m.content, maxContent),
      String(m.accessCount),
    ]),
  );
}

async function handleWrite(args: ParsedArgs): Promise<void> {
  if (!args.value) {
    printError("Usage: neo memory write <content> --type <type> [--scope <scope>]");
    process.exitCode = 1;
    return;
  }

  const type = args.type ?? "knowledge";
  if (!VALID_TYPES.includes(type as MemoryType)) {
    printError(`Invalid type "${type}". Must be one of: ${VALID_TYPES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Validate subtype for knowledge type
  const subtype = args.subtype ?? (type === "knowledge" ? "fact" : undefined);
  if (type === "knowledge" && subtype && !VALID_SUBTYPES.includes(subtype as KnowledgeSubtype)) {
    printError(`Invalid subtype "${subtype}". Must be one of: ${VALID_SUBTYPES.join(", ")}`);
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
      ...(type === "knowledge" && subtype && { subtype: subtype as KnowledgeSubtype }),
      ...(type === "warning" && args.category && { category: args.category }),
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

function handleUpdate(args: ParsedArgs): void {
  if (!args.value) {
    printError("Usage: neo memory update <id> <new content>");
    process.exitCode = 1;
    return;
  }

  // The ID is in value, but we need content too.
  // citty only supports 2 positional args — content comes after ID.
  const argv = process.argv;
  const updateIdx = argv.indexOf("update");
  const idArg = argv[updateIdx + 1];
  const contentArg = argv[updateIdx + 2];

  // Determine if contentArg is actually content or a flag
  const isContentArgAFlag = contentArg?.startsWith("--");
  const hasContent = contentArg && !isContentArgAFlag;

  // Need content
  if (!hasContent) {
    printError("Usage: neo memory update <id> <new content>");
    process.exitCode = 1;
    return;
  }

  // ID is required at this point — validated by args.value check above
  if (!idArg) {
    printError("Usage: neo memory update <id> <new content>");
    process.exitCode = 1;
    return;
  }

  const store = openStore(args.name);
  try {
    store.update(idArg, contentArg as string);
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

    // Display with relevance score
    const maxContent = args.full ? 500 : 60;
    printTable(
      ["ID", "TYPE", "SCOPE", "SCORE", "CONTENT", "ACCESSES"],
      results.map((m) => [
        m.id,
        m.type,
        m.scope,
        `${(m.score * 100).toFixed(0)}%`,
        truncate(m.content, maxContent),
        String(m.accessCount),
      ]),
    );
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

    formatResultsTable(results, args.full);
  } finally {
    store.close();
  }
}

function handleRecent(args: ParsedArgs): void {
  const limit = args.limit ? Number(args.limit) : 10;

  const store = openStore(args.name);
  try {
    const results = store.query({
      ...(args.scope !== "global" && { scope: args.scope }),
      ...(args.type && { types: [args.type as MemoryType] }),
      sortBy: "createdAt",
      limit,
    });

    if (results.length === 0) {
      console.log("No memories found.");
      return;
    }

    formatResultsTable(results, args.full);
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
      console.log();
    }

    // Show top 5 most-accessed memories
    const topAccessed = store.topAccessed(5);
    if (topAccessed.length > 0) {
      console.log("Top 5 most-accessed memories:\n");
      printTable(
        ["ID", "TYPE", "ACCESSES", "CONTENT"],
        topAccessed.map((m) => [m.id, m.type, String(m.accessCount), truncate(m.content, 50)]),
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
      description: "Action: write, forget, update, search, list, stats, recent",
      required: true,
    },
    value: {
      type: "positional",
      description: "Content or ID depending on action",
      required: false,
    },
    type: {
      type: "string",
      description: "Memory type: knowledge, warning, focus",
    },
    subtype: {
      type: "string",
      description: "Knowledge subtype: fact, procedure (only for knowledge type)",
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
    category: {
      type: "string",
      description: "Warning category (e.g. input_validation, testing)",
    },
    tags: {
      type: "string",
      description: "Comma-separated tags",
    },
    name: {
      type: "string",
      description: "Supervisor name",
      default: "supervisor",
    },
    full: {
      type: "boolean",
      description: "Show full content without truncation",
      default: false,
    },
    limit: {
      type: "string",
      description: "Limit number of results (for recent command)",
    },
  },
  async run({ args }) {
    const action = args.action as string;
    const parsed: ParsedArgs = {
      value: args.value as string | undefined,
      type: args.type as string | undefined,
      subtype: args.subtype as string | undefined,
      scope: args.scope as string,
      source: args.source as string,
      expires: args.expires as string | undefined,
      name: args.name as string,
      category: args.category as string | undefined,
      tags: args.tags as string | undefined,
      full: args.full as boolean,
      limit: args.limit as string | undefined,
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
      case "recent":
        return handleRecent(parsed);
      default:
        printError(
          `Unknown action "${action}". Must be one of: write, forget, update, search, list, stats, recent`,
        );
        process.exitCode = 1;
    }
  },
});
