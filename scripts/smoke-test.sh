#!/usr/bin/env bash
# Smoke test for Neo v0.1 — validates build artifacts and CLI basics
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass=0
fail=0

check() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} ${label}"
    pass=$((pass + 1))
  else
    echo -e "  ${RED}✗${NC} ${label}"
    fail=$((fail + 1))
  fi
}

echo "Neo v0.1 Smoke Test"
echo "==================="
echo ""

# Build artifacts exist
echo "Build artifacts:"
check "core dist/index.js exists" test -f packages/core/dist/index.js
check "core dist/index.d.ts exists" test -f packages/core/dist/index.d.ts
check "cli dist/index.js exists" test -f packages/cli/dist/index.js
check "agents dir has YAML files" test -n "$(ls packages/agents/agents/*.yml 2>/dev/null)"
check "workflows dir has YAML files" test -n "$(ls packages/agents/workflows/*.yml 2>/dev/null)"

echo ""

# CLI basics
echo "CLI commands:"
check "neo --version prints 0.1.0" bash -c 'node packages/cli/dist/index.js --version | grep -q "0.1.0"'
check "neo --help shows commands" bash -c 'node packages/cli/dist/index.js --help | grep -q "run"'
check "neo doctor runs without crash" bash -c 'node packages/cli/dist/index.js doctor --output json 2>&1; true'
check "neo agents lists agents" bash -c 'node packages/cli/dist/index.js agents --output json | grep -q "developer"'

echo ""

# Core exports
echo "Core exports:"
CORE_DIST="./packages/core/dist/index.js"
check "VERSION export equals 0.1.0" node -e "import('${CORE_DIST}').then(m => { if(m.VERSION !== '0.1.0') process.exit(1) })"
check "Orchestrator is exported" node -e "import('${CORE_DIST}').then(m => { if(!m.Orchestrator) process.exit(1) })"
check "CostJournal is exported" node -e "import('${CORE_DIST}').then(m => { if(!m.CostJournal) process.exit(1) })"
check "EventJournal is exported" node -e "import('${CORE_DIST}').then(m => { if(!m.EventJournal) process.exit(1) })"
check "WorkflowRegistry is exported" node -e "import('${CORE_DIST}').then(m => { if(!m.WorkflowRegistry) process.exit(1) })"

echo ""
echo "==================="
echo -e "Results: ${GREEN}${pass} passed${NC}, ${RED}${fail} failed${NC}"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
