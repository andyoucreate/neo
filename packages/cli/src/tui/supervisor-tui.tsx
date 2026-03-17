import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityEntry, MemoryEntry, SupervisorDaemonState } from "@neotx/core";
import {
  getSupervisorActivityPath,
  getSupervisorDir,
  getSupervisorInboxPath,
  getSupervisorStatePath,
  loadGlobalConfig,
  MemoryStore,
} from "@neotx/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useState } from "react";

// ─── Constants ───────────────────────────────────────────

const MAX_VISIBLE_ENTRIES = 24;
const POLL_INTERVAL_MS = 1_500;
const ANIMATION_TICK_MS = 400;

// ─── Unicode Visual Elements ─────────────────────────────

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const BLOCK_FULL = "█";
const BLOCK_EMPTY = "░";
const PULSE_FRAMES = ["◉", "◎", "○", "◎"];
const IDLE_FRAMES = ["◌", "◌", "◌", "◌"];

const TYPE_ICONS: Record<string, string> = {
  heartbeat: "♥",
  decision: "★",
  action: "⚡",
  error: "✖",
  event: "◆",
  message: "✉",
  thinking: "◇",
  plan: "▸",
  dispatch: "↗",
  tool_use: "⊘",
};

const TYPE_COLORS: Record<string, string> = {
  heartbeat: "#6ee7b7",
  decision: "#fbbf24",
  action: "#60a5fa",
  error: "#f87171",
  event: "#c084fc",
  message: "#67e8f9",
  thinking: "#a78bfa",
  plan: "#34d399",
  dispatch: "#f472b6",
  tool_use: "#38bdf8",
};

const TYPE_LABELS: Record<string, string> = {
  heartbeat: "BEAT",
  decision: "DECIDE",
  action: "ACTION",
  error: "ERROR",
  event: "EVENT",
  message: "MSG",
  thinking: "THINK",
  plan: "PLAN",
  dispatch: "SEND",
  tool_use: "TOOL",
};

// ─── Helpers ─────────────────────────────────────────────

function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19);
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTimeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function buildProgressBar(ratio: number, width: number): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filledCount = Math.round(clamped * width);
  return {
    filled: BLOCK_FULL.repeat(filledCount),
    empty: BLOCK_EMPTY.repeat(width - filledCount),
  };
}

function buildSparkline(values: number[], width: number): string {
  if (values.length === 0) return "▁".repeat(width);
  const recent = values.slice(-width);
  const max = Math.max(...recent, 0.001);
  return recent
    .map((v) => {
      const idx = Math.min(
        Math.floor((v / max) * (SPARK_CHARS.length - 1)),
        SPARK_CHARS.length - 1,
      );
      return SPARK_CHARS[idx];
    })
    .join("");
}

function extractCostHistory(entries: ActivityEntry[]): number[] {
  return entries
    .filter((e) => e.type === "heartbeat" && e.summary.includes("complete"))
    .map((e) => {
      const detail = e.detail as Record<string, unknown> | undefined;
      return typeof detail?.costUsd === "number" ? detail.costUsd : 0;
    });
}

// ─── Animated Hooks ──────────────────────────────────────

function useAnimationFrame(): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setFrame((f) => f + 1), ANIMATION_TICK_MS);
    return () => clearInterval(interval);
  }, []);
  return frame;
}

function useClock(): string {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(interval);
  }, []);
  return time;
}

// ─── Components ──────────────────────────────────────────

function Logo() {
  return (
    <Box paddingX={1} gap={1}>
      <Text color="#c084fc" bold>
        ◆
      </Text>
      <Text bold>
        <Text color="#c084fc">N</Text>
        <Text color="#a78bfa">E</Text>
        <Text color="#818cf8">O</Text>
      </Text>
      <Text dimColor>SUPERVISOR</Text>
    </Box>
  );
}

function LiveIndicator({ frame, isRunning }: { frame: number; isRunning: boolean }) {
  const frames = isRunning ? PULSE_FRAMES : IDLE_FRAMES;
  const dot = frames[frame % frames.length];
  return (
    <Box paddingX={1}>
      <Text color={isRunning ? "#4ade80" : "#6b7280"} bold>
        {dot}
      </Text>
      <Text color={isRunning ? "#4ade80" : "#6b7280"} bold>
        {" "}
        {isRunning ? "LIVE" : "IDLE"}
      </Text>
    </Box>
  );
}

function HeaderBar({
  state,
  name,
  frame,
  clock,
}: {
  state: SupervisorDaemonState | null;
  name: string;
  frame: number;
  clock: string;
}) {
  if (!state) {
    return (
      <Box borderStyle="round" borderColor="#6b7280" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Logo />
          <Box paddingX={1}>
            <Text dimColor>{clock}</Text>
          </Box>
        </Box>
        <Box paddingX={1}>
          <Text color="#fbbf24">⟳ Connecting to "{name}"...</Text>
        </Box>
      </Box>
    );
  }

  const isRunning = state.status === "running";

  return (
    <Box
      borderStyle="round"
      borderColor={isRunning ? "#6ee7b7" : "#f87171"}
      paddingX={0}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Logo />
        <Box gap={2}>
          <LiveIndicator frame={frame} isRunning={isRunning} />
          <Box paddingX={1}>
            <Text dimColor>{clock}</Text>
          </Box>
        </Box>
      </Box>

      <Box paddingX={1} gap={1}>
        <Text dimColor>│</Text>
        <Text>
          <Text dimColor>pid</Text> <Text bold>{state.pid}</Text>
        </Text>
        <Text dimColor>·</Text>
        <Text>
          <Text dimColor>port</Text> <Text bold>:{state.port}</Text>
        </Text>
        <Text dimColor>·</Text>
        <Text>
          <Text dimColor>beats</Text>{" "}
          <Text bold color="#6ee7b7">
            ▲{state.heartbeatCount}
          </Text>
        </Text>
        {state.lastHeartbeat && (
          <>
            <Text dimColor>·</Text>
            <Text>
              <Text dimColor>last</Text> <Text>{formatTimeAgo(state.lastHeartbeat)}</Text>
            </Text>
          </>
        )}
        <Text dimColor>·</Text>
        <Text>
          <Text dimColor>up</Text> <Text>{formatUptime(state.startedAt)}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function BudgetPanel({
  state,
  dailyCap,
  costHistory,
}: {
  state: SupervisorDaemonState | null;
  dailyCap: number;
  costHistory: number[];
}) {
  if (!state) return null;

  const todayCost = state.todayCostUsd ?? 0;
  const totalCost = state.totalCostUsd ?? 0;
  const ratio = dailyCap > 0 ? todayCost / dailyCap : 0;
  const barWidth = 20;
  const bar = buildProgressBar(ratio, barWidth);
  const pct = Math.round(ratio * 100);

  const barColor = pct < 50 ? "#4ade80" : pct < 80 ? "#fbbf24" : "#f87171";

  const sparkline = buildSparkline(costHistory, 12);

  return (
    <Box paddingX={2} gap={2}>
      <Box gap={1}>
        <Text dimColor>budget</Text>
        <Text color={barColor}>{bar.filled}</Text>
        <Text dimColor>{bar.empty}</Text>
        <Text bold color={barColor}>
          {pct}%
        </Text>
        <Text dimColor>
          (${todayCost.toFixed(2)}/${dailyCap})
        </Text>
      </Box>
      <Text dimColor>│</Text>
      <Box gap={1}>
        <Text dimColor>total</Text>
        <Text bold>${totalCost.toFixed(2)}</Text>
      </Box>
      <Text dimColor>│</Text>
      <Box gap={1}>
        <Text dimColor>cost/beat</Text>
        <Text color="#818cf8">{sparkline}</Text>
      </Box>
    </Box>
  );
}

function ActivityRow({
  entry,
  isLatest,
  isOld,
}: {
  entry: ActivityEntry;
  isLatest: boolean;
  isOld: boolean;
}) {
  const icon = TYPE_ICONS[entry.type] ?? "·";
  const color = TYPE_COLORS[entry.type] ?? "#9ca3af";
  const label = (TYPE_LABELS[entry.type] ?? (entry.type as string).toUpperCase()).padEnd(7);

  return (
    <Box gap={1} paddingX={2}>
      <Text dimColor={isOld}>{isLatest ? "│" : "│"}</Text>
      <Text dimColor={isOld}>{formatTime(entry.timestamp)}</Text>
      <Text color={color} dimColor={isOld} bold={isLatest}>
        {icon}
      </Text>
      <Text color={color} dimColor={isOld} bold>
        {label}
      </Text>
      <Text dimColor={isOld} bold={isLatest}>
        {entry.summary}
      </Text>
    </Box>
  );
}

const TASK_STATUS_COLORS: Record<string, string> = {
  in_progress: "#60a5fa",
  blocked: "#f87171",
  pending: "#6b7280",
  done: "#4ade80",
};

const TASK_STATUS_LABELS: Record<string, string> = {
  in_progress: "ACTIVE",
  blocked: "BLOCK",
  pending: "·",
};

function TaskPanel({ tasks }: { tasks: MemoryEntry[] }) {
  const active = tasks.filter((t) => t.outcome !== "done" && t.outcome !== "abandoned");
  const doneCount = tasks.filter((t) => t.outcome === "done").length;

  if (tasks.length === 0) return null;

  const MAX_VISIBLE = 6;
  const visible = active.slice(0, MAX_VISIBLE);
  const overflow = active.length - visible.length;

  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          TASKS
        </Text>
        <Text dimColor>
          ({active.length} active, {doneCount} done)
        </Text>
        <Text dimColor>{"─".repeat(30)}</Text>
      </Box>
      {visible.map((t) => {
        const status = t.outcome ?? "pending";
        const color = TASK_STATUS_COLORS[status] ?? "#6b7280";
        const label = (TASK_STATUS_LABELS[status] ?? "·").padEnd(6);
        const prio = t.severity ? `[${t.severity.slice(0, 3)}] ` : "";
        const repo = t.scope !== "global" ? path.basename(t.scope) : "";
        const run = t.runId ? `run:${t.runId.slice(0, 4)}` : "";
        const meta = [repo, run].filter(Boolean).join(" ");

        return (
          <Box key={t.id} gap={1} paddingX={2}>
            <Text dimColor>│</Text>
            <Text color={color} bold>
              {label}
            </Text>
            {prio && <Text dimColor>{prio.padEnd(5)}</Text>}
            <Text wrap="truncate">{t.content}</Text>
            {meta && <Text dimColor>({meta})</Text>}
          </Box>
        );
      })}
      {overflow > 0 && (
        <Box paddingX={2}>
          <Text dimColor>│ ... +{overflow} more pending</Text>
        </Box>
      )}
    </Box>
  );
}

/** Types shown in the activity feed — plan/thinking are internal, not shown */
const ACTIVITY_TYPES = new Set([
  "heartbeat",
  "decision",
  "action",
  "dispatch",
  "error",
  "event",
  "message",
]);

function ActivityPanel({ entries, termHeight }: { entries: ActivityEntry[]; termHeight: number }) {
  // Reserve lines for header (5), budget (1), separator (1), input (2), footer (1) = 10
  const maxVisible = Math.max(5, Math.min(MAX_VISIBLE_ENTRIES, termHeight - 10));
  const filtered = entries.filter((e) => ACTIVITY_TYPES.has(e.type));
  const visible = filtered.slice(-maxVisible);

  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          ACTIVITY
        </Text>
        <Text dimColor>{"─".repeat(40)}</Text>
      </Box>

      {visible.length === 0 ? (
        <Box paddingX={2}>
          <Text dimColor>│ Waiting for heartbeats...</Text>
        </Box>
      ) : (
        visible.map((entry, idx) => (
          <ActivityRow
            key={entry.id}
            entry={entry}
            isLatest={idx === visible.length - 1}
            isOld={idx < visible.length - 5}
          />
        ))
      )}

      <Box paddingX={2}>
        <Text dimColor>│</Text>
      </Box>
    </Box>
  );
}

function InputPanel({
  value,
  onChange,
  onSubmit,
  lastSent,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  lastSent: string;
}) {
  return (
    <Box flexDirection="column">
      <Box paddingX={2} gap={1}>
        <Text dimColor>└</Text>
        <Text bold color="#60a5fa">
          ❯
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="message the supervisor..."
        />
      </Box>
      <Box paddingX={2} gap={1}>
        <Text dimColor> </Text>
        {lastSent ? <Text color="#6b7280">✓ "{lastSent}"</Text> : null}
      </Box>
    </Box>
  );
}

function Footer() {
  return (
    <Box paddingX={2} gap={1} justifyContent="center">
      <Text dimColor>
        <Text bold>esc</Text> quit
      </Text>
      <Text dimColor>·</Text>
      <Text dimColor>
        <Text bold>enter</Text> send
      </Text>
      <Text dimColor>·</Text>
      <Text dimColor>daemon keeps running</Text>
    </Box>
  );
}

// ─── Data Fetching ───────────────────────────────────────

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

function readTasks(name: string): MemoryEntry[] {
  try {
    const dir = getSupervisorDir(name);
    const store = new MemoryStore(path.join(dir, "memory.sqlite"));
    const tasks = store.query({ types: ["task"], limit: 20, sortBy: "createdAt" });
    store.close();
    return tasks;
  } catch {
    return [];
  }
}

async function sendMessage(name: string, text: string): Promise<void> {
  const id = randomUUID();
  const timestamp = new Date().toISOString();

  const message = { id, from: "tui" as const, text, timestamp };
  const inboxPath = getSupervisorInboxPath(name);
  await appendFile(inboxPath, `${JSON.stringify(message)}\n`, "utf-8");

  // Write to activity.jsonl so the message appears in the TUI conversation
  const activityEntry = { id, type: "message", summary: text, timestamp };
  const activityPath = getSupervisorActivityPath(name);
  await appendFile(activityPath, `${JSON.stringify(activityEntry)}\n`, "utf-8");
}

// ─── Main Component ──────────────────────────────────────

export function SupervisorTui({ name }: { name: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const frame = useAnimationFrame();
  const clock = useClock();

  const [state, setState] = useState<SupervisorDaemonState | null>(null);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [tasks, setTasks] = useState<MemoryEntry[]>([]);
  const [dailyCap, setDailyCap] = useState(50);
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [termHeight, setTermHeight] = useState(stdout?.rows ?? 30);

  // Track terminal resize
  useEffect(() => {
    function onResize() {
      if (stdout) setTermHeight(stdout.rows);
    }
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);

  // Load daily cap from config
  useEffect(() => {
    loadGlobalConfig()
      .then((cfg) => setDailyCap(cfg.supervisor.dailyCapUsd))
      .catch(() => {});
  }, []);

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
      setTasks(readTasks(name));
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [name]);

  useInput((_input, key) => {
    if (key.escape) {
      exit();
    }
  });

  const handleSubmit = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      sendMessage(name, text.trim());
      setLastSent(text.trim());
      setInput("");
    },
    [name],
  );

  const costHistory = extractCostHistory(entries);

  return (
    <Box flexDirection="column">
      <HeaderBar state={state} name={name} frame={frame} clock={clock} />
      <BudgetPanel state={state} dailyCap={dailyCap} costHistory={costHistory} />
      <TaskPanel tasks={tasks} />
      <ActivityPanel
        entries={entries}
        termHeight={
          termHeight -
          (tasks.length > 0
            ? Math.min(
                tasks.filter((t) => t.outcome !== "done" && t.outcome !== "abandoned").length,
                6,
              ) + 2
            : 0)
        }
      />
      <InputPanel value={input} onChange={setInput} onSubmit={handleSubmit} lastSent={lastSent} />
      <Footer />
    </Box>
  );
}
