import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActivityEntry,
  ChildHandle,
  Decision,
  InboxMessage,
  SupervisorDaemonState,
  TaskEntry,
} from "@neotx/core";
import {
  DecisionStore,
  getFocusedSupervisorDir,
  getSupervisorActivityPath,
  getSupervisorChildrenPath,
  getSupervisorDecisionsPath,
  getSupervisorDir,
  getSupervisorInboxPath,
  getSupervisorStatePath,
  loadGlobalConfig,
  readChildrenFile,
  TaskStore,
} from "@neotx/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChildDetail } from "./components/child-detail.js";
import type { ChildInputMode } from "./components/child-input.js";
import { ChildInput } from "./components/child-input.js";
import { ChildList } from "./components/child-list.js";

// ─── Constants ───────────────────────────────────────────

const MAX_VISIBLE_ENTRIES = 24;
const MAX_CHILD_ACTIVITY = 12;
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
  columnFocus,
  childCount,
}: {
  state: SupervisorDaemonState | null;
  name: string;
  frame: number;
  clock: string;
  columnFocus: "left" | "right";
  childCount: number;
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
          {childCount > 0 && (
            <Box paddingX={1} gap={1}>
              <Text dimColor>focus:</Text>
              <Text color="#c084fc" bold>
                {columnFocus === "left" ? "ROOT" : "CHILDREN"}
              </Text>
              <Text dimColor>(tab to switch)</Text>
            </Box>
          )}
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

function TaskPanel({ tasks }: { tasks: TaskEntry[] }) {
  const active = tasks.filter((t) => t.status !== "done" && t.status !== "abandoned");
  const doneCount = tasks.filter((t) => t.status === "done").length;

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
        const status = t.status ?? "pending";
        const color = TASK_STATUS_COLORS[status] ?? "#6b7280";
        const label = (TASK_STATUS_LABELS[status] ?? "·").padEnd(6);
        const prio = t.priority ? `[${t.priority.slice(0, 3)}] ` : "";
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
            <Text wrap="truncate">{t.title}</Text>
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

/** Compact banner shown above activity when decisions exist but input is focused on chat */
function DecisionBanner({ decisions, frame }: { decisions: Decision[]; frame: number }) {
  if (decisions.length === 0) return null;

  const pulseChars = ["★", "☆"];
  const pulse = pulseChars[frame % pulseChars.length];

  return (
    <Box paddingX={2} gap={1}>
      <Text dimColor>├</Text>
      <Text color="#fbbf24" bold>
        {pulse} {decisions.length} decision{decisions.length > 1 ? "s" : ""} pending
      </Text>
      <Text dimColor>
        — press <Text bold>tab</Text> to review
      </Text>
    </Box>
  );
}

/** Full decision input panel — replaces the chat input when focused */
function DecisionInputPanel({
  decision,
  optionIndex,
  isTextMode,
  textInput,
  onTextChange,
  onSubmit,
  decisionCount,
  decisionIdx,
  frame,
}: {
  decision: Decision;
  optionIndex: number;
  isTextMode: boolean;
  textInput: string;
  onTextChange: (v: string) => void;
  onSubmit: (v: string) => void;
  decisionCount: number;
  decisionIdx: number;
  frame: number;
}) {
  const hasOptions = decision.options && decision.options.length > 0;
  const pulseChars = ["★", "☆"];
  const pulse = pulseChars[frame % pulseChars.length];

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box paddingX={2} gap={1}>
        <Text dimColor>├</Text>
        <Text color="#fbbf24" bold>
          {pulse} DECISION
        </Text>
        {decisionCount > 1 && (
          <Text color="#fbbf24">
            ({decisionIdx + 1}/{decisionCount})
          </Text>
        )}
        <Text dimColor>{"─".repeat(30)}</Text>
      </Box>

      {/* Question */}
      <Box paddingX={2} gap={1}>
        <Text dimColor>│</Text>
        <Text bold wrap="truncate-end">
          {decision.question}
        </Text>
      </Box>

      {/* Context if available */}
      {decision.context && (
        <Box paddingX={2} gap={1}>
          <Text dimColor>│</Text>
          <Text dimColor wrap="truncate-end">
            {decision.context}
          </Text>
        </Box>
      )}

      {/* Option selector or free text */}
      {hasOptions ? (
        <Box flexDirection="column">
          {(decision.options ?? []).map((opt, idx) => {
            const isSelected = idx === optionIndex;
            return (
              <Box key={opt.key} paddingX={2} gap={1}>
                <Text dimColor>│</Text>
                {isSelected ? (
                  <Text color="#fbbf24" bold>
                    ▸ {opt.label}
                  </Text>
                ) : (
                  <Text dimColor>
                    {"  "}
                    {opt.label}
                  </Text>
                )}
                {opt.description && isSelected && <Text dimColor>— {opt.description}</Text>}
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box paddingX={2} gap={1}>
          <Text dimColor>│</Text>
          <Text color="#fbbf24" bold>
            ❯
          </Text>
          <TextInput
            value={textInput}
            onChange={onTextChange}
            onSubmit={onSubmit}
            focus={isTextMode}
            placeholder="type your answer..."
          />
        </Box>
      )}

      {/* Footer hints */}
      <Box paddingX={2} gap={1}>
        <Text dimColor>└</Text>
        <Text dimColor>
          {hasOptions ? (
            <>
              <Text bold>↑↓</Text> choose · <Text bold>enter</Text> confirm
            </>
          ) : (
            <>
              <Text bold>enter</Text> send
            </>
          )}
          {decisionCount > 1 && (
            <>
              {" · "}
              <Text bold>←→</Text> prev/next
            </>
          )}
          {" · "}
          <Text bold>tab</Text> chat · <Text bold>esc</Text> back
        </Text>
      </Box>
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

function ActivityPanel({ entries, maxVisible }: { entries: ActivityEntry[]; maxVisible: number }) {
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
  focus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  lastSent: string;
  focus: boolean;
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
          focus={focus}
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

// ─── Data Fetching ───────────────────────────────────────

async function readState(name: string): Promise<SupervisorDaemonState | null> {
  try {
    const raw = await readFile(getSupervisorStatePath(name), "utf-8");
    return JSON.parse(raw) as SupervisorDaemonState;
  } catch (err) {
    console.debug(
      `[tui] Failed to read supervisor state for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
      } catch (err) {
        console.debug(
          `[tui] Skipping malformed activity line: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return entries;
  } catch (err) {
    console.debug(
      `[tui] Failed to read activity for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function readChildActivity(
  supervisorId: string,
  maxEntries: number,
): Promise<ActivityEntry[]> {
  const activityPath = path.join(getFocusedSupervisorDir(supervisorId), "activity.jsonl");
  try {
    const content = await readFile(activityPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const lastLines = lines.slice(-maxEntries);
    const entries: ActivityEntry[] = [];
    for (const line of lastLines) {
      try {
        entries.push(JSON.parse(line) as ActivityEntry);
      } catch (err) {
        /* skip malformed line */
        console.debug(
          `[tui] Failed to parse child activity line: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return entries;
  } catch (err) {
    console.debug(
      `[tui] Failed to read child activity: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function readTasks(name: string): TaskEntry[] {
  try {
    const dir = getSupervisorDir(name);
    const store = new TaskStore(path.join(dir, "tasks.sqlite"));
    const tasks = store.getTasks();
    store.close();
    return tasks.slice(0, 20);
  } catch (err) {
    console.debug(
      `[tui] Failed to read tasks for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function readDecisions(name: string): Promise<Decision[]> {
  try {
    const store = new DecisionStore(getSupervisorDecisionsPath(name));
    return await store.pending();
  } catch (err) {
    console.debug(
      `[tui] Failed to read decisions for ${name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Appends a JSON entry to a JSONL file.
 * Creates the parent directory if needed. Returns false on error.
 */
async function appendToJsonl(filePath: string, data: unknown): Promise<boolean> {
  const dir = path.dirname(filePath);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, `${JSON.stringify(data)}\n`, "utf-8");
    return true;
  } catch (error) {
    console.error(
      `Warning: Failed to write to ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * Writes a message to the supervisor's inbox.jsonl file.
 */
async function writeToInbox(name: string, message: InboxMessage): Promise<boolean> {
  const inboxPath = getSupervisorInboxPath(name);
  return appendToJsonl(inboxPath, message);
}

async function answerDecision(name: string, id: string, answer: string): Promise<void> {
  const store = new DecisionStore(getSupervisorDecisionsPath(name));
  await store.answer(id, answer);

  const inboxMessage: InboxMessage = {
    id: randomUUID(),
    from: "tui",
    text: `decision:answer ${id} ${answer}`,
    timestamp: new Date().toISOString(),
  };
  await writeToInbox(name, inboxMessage);
}

async function sendMessage(name: string, text: string): Promise<void> {
  const id = randomUUID();
  const timestamp = new Date().toISOString();

  const message: InboxMessage = { id, from: "tui", text, timestamp };
  await writeToInbox(name, message);

  const activityEntry: ActivityEntry = { id, type: "message", summary: text, timestamp };
  const activityPath = getSupervisorActivityPath(name);
  await appendToJsonl(activityPath, activityEntry);
}

// ─── Main Component ──────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Main TUI component with complex keyboard/state interactions; splitting would fragment cohesive UI logic
export function SupervisorTui({ name }: { name: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const frame = useAnimationFrame();
  const clock = useClock();

  // Root supervisor state
  const [state, setState] = useState<SupervisorDaemonState | null>(null);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [dailyCap, setDailyCap] = useState(50);
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [termHeight, setTermHeight] = useState(stdout?.rows ?? 30);

  // Decision interaction state
  const [decisionIndex, setDecisionIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [decisionAnswer, setDecisionAnswer] = useState("");
  const [focusMode, setFocusMode] = useState<"input" | "decisions">("input");

  // Child supervisor state
  const [children, setChildren] = useState<ChildHandle[]>([]);
  const [selectedChildIndex, setSelectedChildIndex] = useState(0);
  const [childActivity, setChildActivity] = useState<ActivityEntry[]>([]);
  const [columnFocus, setColumnFocus] = useState<"left" | "right">("left");
  const [childInputMode, setChildInputMode] = useState<ChildInputMode>("idle");
  const [childInputValue, setChildInputValue] = useState("");

  const hasChildren = children.length > 0;
  const selectedChild = children[selectedChildIndex] as ChildHandle | undefined;

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
      .catch((err) => {
        console.debug("[tui] Failed to load global config:", err);
      });
  }, []);

  // Refs to avoid stale closures inside poll without restarting the timer
  const decisionIndexRef = useRef(decisionIndex);
  const decisionsLengthRef = useRef(decisions.length);
  useEffect(() => {
    decisionIndexRef.current = decisionIndex;
  }, [decisionIndex]);
  useEffect(() => {
    decisionsLengthRef.current = decisions.length;
  }, [decisions.length]);

  // Poll root state, activity, decisions, and children
  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;
      const [newState, newEntries, newDecisions, newChildren] = await Promise.all([
        readState(name),
        readActivity(name, MAX_VISIBLE_ENTRIES),
        readDecisions(name),
        readChildrenFile(getSupervisorChildrenPath(name)).catch((err) => {
          // File not found is expected when no children exist - only log real errors
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            console.debug(`[TUI] readChildrenFile failed: ${err}`);
          }
          return [] as ChildHandle[];
        }),
      ]);
      if (!active) return;
      setState(newState);
      setEntries(newEntries);
      setDecisions(newDecisions);
      // Clamp selectedChildIndex if children list shrinks
      setSelectedChildIndex((i) => Math.min(i, Math.max(0, newChildren.length - 1)));
      setChildren(newChildren);
      setTasks(readTasks(name));
      // Reset decision index if out of bounds (using ref to avoid dep)
      if (newDecisions.length > 0 && decisionIndexRef.current >= newDecisions.length) {
        setDecisionIndex(0);
      }
      // Auto-switch to decisions mode when new decisions appear
      if (newDecisions.length > 0 && decisionsLengthRef.current === 0) {
        setFocusMode("decisions");
      }
      // Return to input mode when all decisions are resolved
      if (newDecisions.length === 0 && decisionsLengthRef.current > 0) {
        setFocusMode("input");
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [name]);

  // Poll child activity when selected child id changes
  const selectedChildId = selectedChild?.supervisorId;
  useEffect(() => {
    if (!selectedChildId) {
      setChildActivity([]);
      return;
    }

    // Capture after guard - TypeScript doesn't narrow inside async closures
    const childId = selectedChildId;
    let active = true;

    async function poll() {
      if (!active) return;
      const activity = await readChildActivity(childId, MAX_CHILD_ACTIVITY);
      if (!active) return;
      setChildActivity(activity);
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedChildId]);

  // Current decision being interacted with
  const currentDecision = decisions[decisionIndex] as Decision | undefined;
  const currentHasOptions = (currentDecision?.options?.length ?? 0) > 0;

  // Submit the selected option or free-text answer
  const submitDecisionAnswer = useCallback(
    async (answer: string) => {
      if (!answer.trim() || !currentDecision) return;
      try {
        await answerDecision(name, currentDecision.id, answer.trim());
        setLastSent(`Decision ${currentDecision.id.slice(4, 12)}: "${answer.trim()}"`);
        setDecisionAnswer("");
        setOptionIndex(0);
      } catch (err) {
        console.debug(
          `[tui] Failed to answer decision ${currentDecision.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [name, currentDecision],
  );

  const handleOptionNav = useCallback(
    (key: { upArrow: boolean; downArrow: boolean; return: boolean }): boolean => {
      const options = currentDecision?.options;
      if (!options || options.length === 0) return false;

      if (key.upArrow) {
        setOptionIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (key.downArrow) {
        setOptionIndex((i) => Math.min(options.length - 1, i + 1));
        return true;
      }
      if (key.return) {
        const opt = options[optionIndex];
        if (opt) submitDecisionAnswer(opt.key);
        return true;
      }
      return false;
    },
    [currentDecision, optionIndex, submitDecisionAnswer],
  );

  const handleChildInputSubmit = useCallback(
    async (value: string) => {
      if (!selectedChild) return;
      const id = selectedChild.supervisorId;
      let text: string | null = null;
      if (childInputMode === "inject" && value.trim()) {
        text = `child:inject ${id} ${value.trim()}`;
      } else if (childInputMode === "unblock" && value.trim()) {
        text = `child:unblock ${id} ${value.trim()}`;
      } else if (childInputMode === "kill" && value.trim().toLowerCase() === "stop") {
        text = `child:stop ${id}`;
      }
      if (text) {
        const message: InboxMessage = {
          id: randomUUID(),
          from: "tui",
          text,
          timestamp: new Date().toISOString(),
        };
        await writeToInbox(name, message);
        setLastSent(text.slice(0, 40));
      }
      setChildInputMode("idle");
      setChildInputValue("");
    },
    [name, selectedChild, childInputMode],
  );

  const handleRightColumnKey = useCallback(
    (char: string, key: { upArrow: boolean; downArrow: boolean }) => {
      if (key.upArrow) {
        setSelectedChildIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        if (children.length > 0) {
          setSelectedChildIndex((i) => Math.min(children.length - 1, i + 1));
        }
        return;
      }
      if (char === "i") {
        setChildInputMode("inject");
        return;
      }
      if (char === "u" && selectedChild?.status === "blocked") {
        setChildInputMode("unblock");
        return;
      }
      if (char === "k") {
        setChildInputMode("kill");
      }
    },
    [children.length, selectedChild],
  );

  const handleDecisionKey = useCallback(
    (key: {
      upArrow: boolean;
      downArrow: boolean;
      return: boolean;
      leftArrow: boolean;
      rightArrow: boolean;
    }) => {
      if (currentHasOptions && handleOptionNav(key)) return;
      if (decisions.length > 1) {
        if (key.leftArrow) {
          setDecisionIndex((i) => Math.max(0, i - 1));
          setOptionIndex(0);
        } else if (key.rightArrow) {
          setDecisionIndex((i) => Math.min(decisions.length - 1, i + 1));
          setOptionIndex(0);
        }
      }
    },
    [currentHasOptions, handleOptionNav, decisions.length],
  );

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keyboard input handler with extensive keybinding logic; single handler maintains key priority/fallthrough clarity
  useInput((char, key) => {
    if (key.tab) {
      if (hasChildren && focusMode !== "decisions") {
        setColumnFocus((c) => (c === "left" ? "right" : "left"));
        setOptionIndex(0);
      } else if (decisions.length > 0) {
        setFocusMode((m) => (m === "input" ? "decisions" : "input"));
        setOptionIndex(0);
      }
      return;
    }

    if (key.escape) {
      if (childInputMode !== "idle") {
        setChildInputMode("idle");
        setChildInputValue("");
      } else if (columnFocus === "right") {
        setColumnFocus("left");
      } else if (focusMode === "decisions") {
        setFocusMode("input");
      } else {
        exit();
      }
      return;
    }

    if (columnFocus === "right" && childInputMode === "idle") {
      handleRightColumnKey(char, key);
      return;
    }

    if (focusMode === "decisions" && decisions.length > 0 && columnFocus === "left") {
      handleDecisionKey(key);
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

  // Calculate height adjustments for left column panels
  const activeTaskCount = tasks.filter(
    (t) => t.status !== "done" && t.status !== "abandoned",
  ).length;
  const taskPanelLines = tasks.length > 0 ? Math.min(activeTaskCount, 6) + 2 : 0;
  const decisionPanelLines =
    focusMode === "decisions" && currentDecision
      ? (currentHasOptions ? (currentDecision.options?.length ?? 0) : 1) + 4
      : decisions.length > 0
        ? 1
        : 0;

  const leftActivityMaxVisible = Math.max(
    5,
    Math.min(MAX_VISIBLE_ENTRIES, termHeight - 10 - taskPanelLines - decisionPanelLines),
  );

  // Bottom panel: either decision input or chat input
  const bottomPanel =
    focusMode === "decisions" && currentDecision && columnFocus === "left" ? (
      <DecisionInputPanel
        decision={currentDecision}
        optionIndex={optionIndex}
        isTextMode={!currentHasOptions}
        textInput={decisionAnswer}
        onTextChange={setDecisionAnswer}
        onSubmit={submitDecisionAnswer}
        decisionCount={decisions.length}
        decisionIdx={decisionIndex}
        frame={frame}
      />
    ) : (
      <InputPanel
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        lastSent={lastSent}
        focus={columnFocus === "left" && focusMode === "input"}
      />
    );

  return (
    <Box flexDirection="column">
      <HeaderBar
        state={state}
        name={name}
        frame={frame}
        clock={clock}
        columnFocus={columnFocus}
        childCount={children.length}
      />
      <BudgetPanel state={state} dailyCap={dailyCap} costHistory={costHistory} />
      <Box flexDirection="row" flexGrow={1}>
        {/* Left column */}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexBasis={hasChildren ? "50%" : "100%"}
          borderStyle={hasChildren && columnFocus === "left" ? "single" : undefined}
          borderColor="#c084fc"
        >
          {focusMode !== "decisions" && <DecisionBanner decisions={decisions} frame={frame} />}
          <TaskPanel tasks={tasks} />
          <ActivityPanel entries={entries} maxVisible={leftActivityMaxVisible} />
          {bottomPanel}
        </Box>

        {/* Right column — only when children exist */}
        {hasChildren && (
          <Box
            flexDirection="column"
            flexGrow={1}
            flexBasis="50%"
            borderStyle={columnFocus === "right" ? "single" : undefined}
            borderColor="#c084fc"
          >
            <ChildList handles={children} selectedIndex={selectedChildIndex} />
            {selectedChild && (
              <>
                <ChildDetail
                  handle={selectedChild}
                  activity={childActivity}
                  maxActivityLines={MAX_CHILD_ACTIVITY}
                />
                <ChildInput
                  handle={selectedChild}
                  mode={childInputMode}
                  value={childInputValue}
                  onChange={setChildInputValue}
                  onSubmit={handleChildInputSubmit}
                />
              </>
            )}
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box paddingX={2} gap={1} justifyContent="center">
        <Text dimColor>
          <Text bold>esc</Text> quit
        </Text>
        {hasChildren && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>
              <Text bold>tab</Text> switch panel
            </Text>
          </>
        )}
        <Text dimColor>·</Text>
        <Text dimColor>daemon keeps running</Text>
      </Box>
    </Box>
  );
}
