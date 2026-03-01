#!/bin/bash
# readonly-bash.sh — Readonly sandbox for reviewer-security and reviewer-coverage agents
# Same as sandbox-bash.sh but the repo directory is mounted read-only.
# No write access anywhere except /tmp (isolated tmpfs).

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Write command to a temp file to avoid shell injection via bash -c
TMPSCRIPT=$(mktemp /tmp/readonly-cmd.XXXXXX)
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
  --ro-bind "$REPO_DIR" "$REPO_DIR"
  --unshare-pid
  --die-with-parent
)

# Bind the temp script into the sandbox
BWRAP_ARGS+=(--bind "$TMPSCRIPT" "$TMPSCRIPT")

# OS sandbox via bubblewrap (fully read-only):
#   - System dirs: read-only (/usr, /lib, /lib64, /bin, /sbin)
#   - /proc, /dev: mounted for process visibility
#   - /tmp: writable tmpfs (isolated from host /tmp)
#   - Repo dir: READ-ONLY (reviewers must not modify code)
#   - PID namespace isolated, child dies with parent
exec bwrap "${BWRAP_ARGS[@]}" -- /bin/bash "$TMPSCRIPT"
