import type { ActivityEntry, ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";

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

function formatTime(timestamp: string): string {
  return timestamp.slice(11, 19);
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

const STATUS_COLORS: Record<string, string> = {
  running: "#4ade80",
  blocked: "#fbbf24",
  stalled: "#f97316",
  complete: "#818cf8",
  failed: "#f87171",
};

export function ChildDetail({
  handle,
  activity,
  maxActivityLines,
}: {
  handle: ChildHandle;
  activity: ActivityEntry[];
  maxActivityLines: number;
}) {
  const statusColor = STATUS_COLORS[handle.status] ?? "#9ca3af";
  const visible = activity.slice(-maxActivityLines);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text color="#c084fc" bold>
          {handle.supervisorId}
        </Text>
        <Text dimColor>·</Text>
        <Text color={statusColor} bold>
          {handle.status.toUpperCase()}
        </Text>
        <Text dimColor>·</Text>
        <Text dimColor>${handle.costUsd.toFixed(2)}</Text>
        {handle.lastProgressAt && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>{formatTimeAgo(handle.lastProgressAt)}</Text>
          </>
        )}
      </Box>

      {/* Objective */}
      <Box paddingX={1} gap={1}>
        <Text dimColor>│</Text>
        <Text dimColor>obj:</Text>
        <Text wrap="truncate">{handle.objective}</Text>
      </Box>

      {/* Activity divider */}
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          ACTIVITY
        </Text>
        <Text dimColor>{"─".repeat(15)}</Text>
      </Box>

      {/* Activity entries */}
      {visible.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>│ No activity yet...</Text>
        </Box>
      ) : (
        visible.map((entry, idx) => {
          const icon = TYPE_ICONS[entry.type] ?? "·";
          const color = TYPE_COLORS[entry.type] ?? "#9ca3af";
          const isLatest = idx === visible.length - 1;
          const isOld = idx < visible.length - 4;
          return (
            <Box key={entry.id} gap={1} paddingX={1}>
              <Text dimColor={isOld}>{formatTime(entry.timestamp)}</Text>
              <Text color={color} dimColor={isOld} bold={isLatest}>
                {icon}
              </Text>
              <Text dimColor={isOld} bold={isLatest} wrap="truncate">
                {entry.summary}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
