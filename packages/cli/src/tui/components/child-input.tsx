import type { ChildHandle } from "@neotx/core";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export type ChildInputMode = "idle" | "inject" | "unblock" | "kill";

export function ChildInput({
  handle,
  mode,
  value,
  onChange,
  onSubmit,
}: {
  handle: ChildHandle;
  mode: ChildInputMode;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  const isBlocked = handle.status === "blocked";

  if (mode === "idle") {
    return (
      <Box paddingX={1} gap={2} flexDirection="column">
        <Box paddingX={1} gap={1}>
          <Text dimColor>└</Text>
          <Text dimColor>
            <Text bold>i</Text> inject context
          </Text>
          <Text dimColor>·</Text>
          <Text dimColor={!isBlocked}>
            <Text bold={isBlocked}>u</Text> unblock{!isBlocked ? " (not blocked)" : ""}
          </Text>
          <Text dimColor>·</Text>
          <Text dimColor>
            <Text bold color="#f87171">
              k
            </Text>{" "}
            kill
          </Text>
          <Text dimColor>·</Text>
          <Text dimColor>
            <Text bold>esc</Text> back
          </Text>
        </Box>
      </Box>
    );
  }

  if (mode === "inject") {
    return (
      <Box flexDirection="column">
        <Box paddingX={1} gap={1}>
          <Text dimColor>└</Text>
          <Text color="#60a5fa" bold>
            INJECT
          </Text>
          <Text dimColor>→ {handle.supervisorId}</Text>
        </Box>
        <Box paddingX={1} gap={1}>
          <Text dimColor> </Text>
          <Text color="#60a5fa" bold>
            ❯
          </Text>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            focus
            placeholder="context to inject..."
          />
        </Box>
        <Box paddingX={1}>
          <Text dimColor> enter send · esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "unblock") {
    return (
      <Box flexDirection="column">
        <Box paddingX={1} gap={1}>
          <Text dimColor>└</Text>
          <Text color="#fbbf24" bold>
            UNBLOCK
          </Text>
          <Text dimColor>→ {handle.supervisorId}</Text>
        </Box>
        <Box paddingX={1} gap={1}>
          <Text dimColor> </Text>
          <Text color="#fbbf24" bold>
            ❯
          </Text>
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            focus
            placeholder="your answer..."
          />
        </Box>
        <Box paddingX={1}>
          <Text dimColor> enter send · esc cancel</Text>
        </Box>
      </Box>
    );
  }

  // kill mode — requires typing "stop" to confirm
  return (
    <Box flexDirection="column">
      <Box paddingX={1} gap={1}>
        <Text dimColor>└</Text>
        <Text color="#f87171" bold>
          KILL
        </Text>
        <Text dimColor>→ {handle.supervisorId}</Text>
        <Text dimColor>— type</Text>
        <Text bold color="#f87171">
          stop
        </Text>
        <Text dimColor>to confirm</Text>
      </Box>
      <Box paddingX={1} gap={1}>
        <Text dimColor> </Text>
        <Text color="#f87171" bold>
          ❯
        </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus
          placeholder='type "stop" to kill...'
        />
      </Box>
      <Box paddingX={1}>
        <Text dimColor> esc cancel</Text>
      </Box>
    </Box>
  );
}
