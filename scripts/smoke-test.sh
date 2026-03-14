#!/bin/bash
set -e

echo "=== Neo v0.1 Smoke Test ==="

# Build
echo "→ Building..."
pnpm build

# Type check
echo "→ Type checking..."
pnpm typecheck

# Tests
echo "→ Running tests..."
pnpm test

# CLI commands
echo "→ Testing CLI commands..."
pnpm --filter @neo-cli/cli exec neo --help > /dev/null
pnpm --filter @neo-cli/cli exec neo --version
pnpm --filter @neo-cli/cli exec neo doctor --output json
pnpm --filter @neo-cli/cli exec neo agents --output json

# Init in temp dir
echo "→ Testing init..."
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
git init -q
# Run neo init from the workspace
NEO_BIN="$(cd - > /dev/null && pnpm --filter @neo-cli/cli exec which neo)"
"$NEO_BIN" init --budget 100
test -f .neo/config.yml

# Cleanup
rm -rf "$TMPDIR"

echo ""
echo "✓ All smoke tests passed"
