#!/bin/bash
# sandbox-bash.sh — OS-level sandbox for developer/fixer/QA agents
# Wraps Bash commands in bubblewrap (bwrap) for filesystem isolation.
# bwrap is the REAL security boundary. The blocklist below is defense-in-depth only.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Defense-in-depth: quick blocklist (NOT the security boundary)
# These patterns are trivially bypassable (base64, eval, etc.) — bwrap is what actually protects.
OBVIOUS_BLOCKS="rm -rf /|rm -rf ~|mkfs|fdisk|shutdown|reboot|poweroff|npm publish|pnpm publish"
if echo "$CMD" | grep -qiE "$OBVIOUS_BLOCKS"; then
  echo "BLOCKED: Dangerous command pattern: $CMD" >&2
  exit 2
fi

# Write command to a temp file to avoid shell injection via bash -c
TMPSCRIPT=$(mktemp /tmp/sandbox-cmd.XXXXXX)
trap 'rm -f "$TMPSCRIPT"' EXIT
echo "$CMD" > "$TMPSCRIPT"
chmod +x "$TMPSCRIPT"

# Resolve the repository root directory
REPO_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Build bwrap arguments
BWRAP_ARGS=(
  --ro-bind /usr /usr
  --ro-bind /lib /lib
)

# Conditionally bind /lib64 only if it exists
if [ -d /lib64 ]; then
  BWRAP_ARGS+=(--ro-bind /lib64 /lib64)
fi

BWRAP_ARGS+=(
  --ro-bind /bin /bin
  --ro-bind /sbin /sbin
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --bind "$REPO_DIR" "$REPO_DIR"
)

# Conditionally bind npm/node caches only if they exist
if [ -d /home/voltaire/.npm ]; then
  BWRAP_ARGS+=(--ro-bind /home/voltaire/.npm /home/voltaire/.npm)
fi
if [ -d /home/voltaire/.node ]; then
  BWRAP_ARGS+=(--ro-bind /home/voltaire/.node /home/voltaire/.node)
fi

BWRAP_ARGS+=(
  --unshare-pid
  --die-with-parent
)

# Copy the temp script into the sandbox /tmp before exec replaces this process
# Since /tmp is a tmpfs, we bind the script into the sandbox explicitly
BWRAP_ARGS+=(--bind "$TMPSCRIPT" "$TMPSCRIPT")

# OS sandbox via bubblewrap:
#   - System dirs: read-only (/usr, /lib, /lib64, /bin, /sbin)
#   - /proc, /dev: mounted for process visibility
#   - /tmp: writable tmpfs (isolated from host /tmp)
#   - Repo dir: read-write (agents need to edit code)
#   - npm/node caches: read-only
#   - PID namespace isolated, child dies with parent
#   - Network: allowed (needed for npm install, API calls)
exec bwrap "${BWRAP_ARGS[@]}" -- /bin/bash "$TMPSCRIPT"
