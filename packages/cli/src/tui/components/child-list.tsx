import type { ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";

const STATUS_COLORS: Record<string, string> = {
  running: "#4ade80",
  blocked: "#fbbf24",
  stalled: "#f97316",
  complete: "#818cf8",
  failed: "#f87171",
};

const STATUS_ICONS: Record<string, string> = {
  running: "●",
  blocked: "◆",
  stalled: "◌",
  complete: "✓",
  failed: "✖",
};

const STATUS_LABELS: Record<string, string> = {
  running: "RUN",
  blocked: "BLK",
  stalled: "STL",
  complete: "DONE",
  failed: "FAIL",
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function ChildRow({ handle, isSelected }: { handle: ChildHandle; isSelected: boolean }) {
  const color = STATUS_COLORS[handle.status] ?? "#9ca3af";
  const icon = STATUS_ICONS[handle.status] ?? "·";
  const label = (STATUS_LABELS[handle.status] ?? handle.status).padEnd(4);
  const cost = `$${handle.costUsd.toFixed(2)}`;
  const id = truncate(handle.supervisorId, 12);
  const objective = truncate(handle.objective, 28);

  return (
    <Box gap={1} paddingX={1}>
      <Text color={isSelected ? "#c084fc" : "#4b5563"}>{isSelected ? "▶" : " "}</Text>
      <Text color={color} bold>
        {icon}
      </Text>
      <Text color={color} bold>
        {label}
      </Text>
      <Text bold={isSelected} dimColor={!isSelected}>
        {id}
      </Text>
      <Text dimColor>·</Text>
      <Text dimColor>{cost}</Text>
      <Text dimColor>·</Text>
      <Text dimColor={!isSelected} wrap="truncate">
        {objective}
      </Text>
    </Box>
  );
}

export function ChildList({
  children,
  selectedIndex,
}: {
  children: ChildHandle[];
  selectedIndex: number;
}) {
  if (children.length === 0) {
    return (
      <Box paddingX={2}>
        <Text dimColor>No focused supervisors running</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>├</Text>
        <Text dimColor bold>
          CHILDREN
        </Text>
        <Text dimColor>({children.length})</Text>
        <Text dimColor>{"─".repeat(20)}</Text>
      </Box>
      {children.map((handle, idx) => (
        <ChildRow key={handle.supervisorId} handle={handle} isSelected={idx === selectedIndex} />
      ))}
    </Box>
  );
}
