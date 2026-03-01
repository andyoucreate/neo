#!/bin/bash
# readonly-bash.sh — Readonly sandbox for reviewer-security and reviewer-coverage agents
# Same as sandbox-bash.sh but the repo directory is mounted read-only.
# No write access anywhere except /tmp (isolated tmpfs).

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Resolve the repository root directory
REPO_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# OS sandbox via bubblewrap (fully read-only):
#   - System dirs: read-only (/usr, /lib, /lib64, /bin, /sbin)
#   - /proc, /dev: mounted for process visibility
#   - /tmp: writable tmpfs (isolated from host /tmp)
#   - Repo dir: READ-ONLY (reviewers must not modify code)
#   - PID namespace isolated, child dies with parent
exec bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 2>/dev/null \
  --ro-bind /bin /bin \
  --ro-bind /sbin /sbin \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --ro-bind "$REPO_DIR" "$REPO_DIR" \
  --unshare-pid \
  --die-with-parent \
  -- /bin/bash -c "$CMD"
