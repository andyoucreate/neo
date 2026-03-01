#!/bin/bash
# protect-files.sh — Block edits to sensitive files
# Runs as a PreToolUse hook on Edit/Write tools to prevent modification
# of secrets, credentials, CI configs, and infrastructure files.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Protected file patterns (bash glob matching)
PROTECTED=(
  ".env"
  ".env.*"
  "*.pem"
  "*.key"
  "*credentials*"
  "*secret*"
  "docker-compose.yml"
  "Dockerfile"
  ".github/workflows/*"
  "openclaw.json"
  ".claude/hooks/*"
)

BASENAME=$(basename "$FILE_PATH")

for pattern in "${PROTECTED[@]}"; do
  if [[ "$FILE_PATH" == $pattern ]] || \
     [[ "$BASENAME" == $pattern ]] || \
     [[ "$FILE_PATH" == */$pattern ]]; then
    echo "BLOCKED: Protected file: $FILE_PATH" >&2
    exit 2
  fi
done

exit 0
