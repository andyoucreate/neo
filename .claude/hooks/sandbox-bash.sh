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

# Resolve the repository root directory
REPO_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# OS sandbox via bubblewrap:
#   - System dirs: read-only (/usr, /lib, /lib64, /bin, /sbin)
#   - /proc, /dev: mounted for process visibility
#   - /tmp: writable tmpfs (isolated from host /tmp)
#   - Repo dir: read-write (agents need to edit code)
#   - npm/node caches: read-only
#   - PID namespace isolated, child dies with parent
#   - Network: allowed (needed for npm install, API calls)
exec bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 2>/dev/null \
  --ro-bind /bin /bin \
  --ro-bind /sbin /sbin \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --bind "$REPO_DIR" "$REPO_DIR" \
  --ro-bind /home/voltaire/.npm /home/voltaire/.npm 2>/dev/null \
  --ro-bind /home/voltaire/.node /home/voltaire/.node 2>/dev/null \
  --unshare-pid \
  --die-with-parent \
  -- /bin/bash -c "$CMD"
