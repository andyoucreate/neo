import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import type { ActivityEntry, SupervisorDaemonState } from "@neo-cli/core";
import {
  getSupervisorActivityPath,
  getSupervisorInboxPath,
  getSupervisorStatePath,
} from "@neo-cli/core";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";

const MAX_VISIBLE_ENTRIES = 20;
const POLL_INTERVAL_MS = 2_000;

interface SupervisorTuiProps {
  name: string;
}

function typeColor(type: ActivityEntry["type"]): string {
  switch (type) {
    case "heartbeat":
      return "cyan";
    case "decision":
      return "yellow";
    case "action":
      return "green";
    case "error":
      return "red";
    case "event":
      return "magenta";
    case "message":
      return "blue";
    default:
      return "white";
  }
}

function typeBadge(type: ActivityEntry["type"]): string {
  switch (type) {
    case "heartbeat":
      return "BEAT";
    case "decision":
      return "DECIDE";
    case "action":
      return "ACTION";
    case "error":
      return "ERROR";
    case "event":
      return "EVENT";
    case "message":
      return "MSG";
    default:
      return (type as string).toUpperCase();
  }
}

function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19);
}

function StatusBar({ state, name }: { state: SupervisorDaemonState | null; name: string }) {
  if (!state) {
    return (
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="yellow">
          neo supervisor: {name}
        </Text>
        <Text dimColor> | connecting...</Text>
      </Box>
    );
  }

  const statusColor =
    state.status === "running" ? "green" : state.status === "draining" ? "yellow" : "red";

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Text>
        <Text bold color="green">
          neo supervisor: {name}
        </Text>
        <Text dimColor> | </Text>
        <Text color={statusColor}>{state.status}</Text>
        <Text dimColor> | </Text>
        <Text>PID {state.pid}</Text>
        <Text dimColor> | </Text>
        <Text>:{state.port}</Text>
      </Text>
      <Text>
        <Text dimColor>beats:</Text>
        <Text>{state.heartbeatCount}</Text>
        <Text dimColor> | $</Text>
        <Text>{(state.todayCostUsd ?? 0).toFixed(2)}</Text>
        <Text dimColor>/day</Text>
        <Text dimColor> | $</Text>
        <Text>{(state.totalCostUsd ?? 0).toFixed(2)}</Text>
        <Text dimColor>/total</Text>
      </Text>
    </Box>
  );
}

function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text dimColor>No activity yet. Waiting for heartbeats...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {entries.map((entry) => (
        <Box key={entry.id} gap={1}>
          <Text dimColor>{formatTime(entry.timestamp)}</Text>
          <Text color={typeColor(entry.type)} bold>
            {typeBadge(entry.type).padEnd(7)}
          </Text>
          <Text wrap="truncate">{entry.summary}</Text>
        </Box>
      ))}
    </Box>
  );
}

function InputBar({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text bold color="cyan">
        {">"}{" "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="Send a message to supervisor..."
      />
    </Box>
  );
}

async function readState(name: string): Promise<SupervisorDaemonState | null> {
  try {
    const raw = await readFile(getSupervisorStatePath(name), "utf-8");
    return JSON.parse(raw) as SupervisorDaemonState;
  } catch {
    return null;
  }
}

async function readActivity(name: string, maxEntries: number): Promise<ActivityEntry[]> {
  try {
    const content = await readFile(getSupervisorActivityPath(name), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const lastLines = lines.slice(-maxEntries);
    const entries: ActivityEntry[] = [];
    for (const line of lastLines) {
      try {
        entries.push(JSON.parse(line) as ActivityEntry);
      } catch {
        // Skip malformed
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function sendMessage(name: string, text: string): Promise<void> {
  const message = {
    id: randomUUID(),
    from: "tui" as const,
    text,
    timestamp: new Date().toISOString(),
  };
  const inboxPath = getSupervisorInboxPath(name);
  await appendFile(inboxPath, `${JSON.stringify(message)}\n`, "utf-8");
}

export function SupervisorTui({ name }: SupervisorTuiProps) {
  const { exit } = useApp();
  const [state, setState] = useState<SupervisorDaemonState | null>(null);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");

  // Poll state and activity
  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;
      const [newState, newEntries] = await Promise.all([
        readState(name),
        readActivity(name, MAX_VISIBLE_ENTRIES),
      ]);
      if (!active) return;
      setState(newState);
      setEntries(newEntries);
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [name]);

  // Ctrl+C to exit TUI (not daemon)
  useInput((_, key) => {
    if (key.escape) {
      exit();
    }
  });

  function handleSubmit(text: string) {
    if (!text.trim()) return;
    sendMessage(name, text.trim());
    setLastSent(text.trim());
    setInput("");
  }

  return (
    <Box flexDirection="column">
      <StatusBar state={state} name={name} />

      <ActivityList entries={entries} />

      <InputBar value={input} onChange={setInput} onSubmit={handleSubmit} />

      <Box paddingX={1}>
        <Text dimColor>
          {lastSent ? `Sent: "${lastSent}" ` : ""}
          Press Esc to exit TUI (daemon keeps running)
        </Text>
      </Box>
    </Box>
  );
}
