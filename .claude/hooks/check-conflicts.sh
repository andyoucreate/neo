#!/bin/bash
# check-conflicts.sh — Detect merge conflicts before commit
# Runs as a PreToolUse hook before git commit to ensure
# the current branch can merge cleanly into the base branch.

INPUT=$(cat)
BASE_BRANCH="origin/develop"

# Check for conflict markers in the diff against the base branch
# git diff --check is stable across all git versions
if git diff --check "$BASE_BRANCH"...HEAD 2>/dev/null | grep -q "conflict"; then
  echo "Conflict markers detected. Rebase before committing." >&2
  exit 2
fi

# Guarantee cleanup even if the script is interrupted (kill, OOM, etc.)
cleanup() {
  git merge --abort 2>/dev/null || true
}
trap cleanup EXIT

# Dry-run merge to detect conflicts that would occur on merge
if ! git merge --no-commit --no-ff "$BASE_BRANCH" > /dev/null 2>&1; then
  echo "Merge conflict detected with $BASE_BRANCH. Rebase before committing." >&2
  exit 2
fi

exit 0
