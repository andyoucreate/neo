#!/bin/bash
# watchdog.sh — Independent system watchdog (runs via system cron, NOT OpenClaw)
set -euo pipefail

# Check if OpenClaw is alive
if ! curl -sf http://127.0.0.1:18789/health > /dev/null 2>&1; then
  systemctl restart openclaw
  echo "OpenClaw restarted at $(date)" | mail -s "VOLTAIRE ALERT" karl@example.com
fi

# Check disk space
USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$USAGE" -gt 90 ]; then
  # Emergency cleanup (use -type f to avoid deleting directory structure)
  find ~/.openclaw/acpx/sessions/ -type f -mtime +7 -delete
  find ~/.openclaw/acpx/sessions/ -type d -empty -mtime +7 -delete
  find /tmp -type f -name "playwright-*" -mtime +1 -delete
  echo "Disk at ${USAGE}%, cleaned old sessions" | mail -s "VOLTAIRE DISK ALERT" karl@example.com
fi
