#!/bin/bash
# deploy-dispatch.sh — Pull latest code, rebuild, and restart the dispatch service
set -euo pipefail

REPO_DIR=/home/voltaire/repos/neo
SERVICE=voltaire-dispatch

echo "=== Deploying Voltaire Dispatch Service ==="

# 1. Pull latest changes
echo "Pulling latest changes..."
cd "$REPO_DIR"
git pull origin main

# 2. Install dependencies + build
echo "Installing dependencies and building..."
cd "$REPO_DIR/dispatch-service"
pnpm install --frozen-lockfile
pnpm build

# 3. Restart the service
echo "Restarting $SERVICE..."
sudo systemctl restart "$SERVICE"

# 4. Verify
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  echo "=== Deploy complete — $SERVICE is running ==="
else
  echo "ERROR: $SERVICE failed to start"
  journalctl -u "$SERVICE" --no-pager -n 20
  exit 1
fi
