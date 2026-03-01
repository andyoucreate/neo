#!/bin/bash
# watchdog.sh — Independent system watchdog (runs via system cron, NOT OpenClaw)
# Covers: OpenClaw health, disk space, ACPX stuck sessions, CPU abuse
set -euo pipefail

ALERT_EMAIL="karl@example.com"
LOG_FILE="/opt/voltaire/watchdog.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

# -------------------------------------------------------------------
# 1. OpenClaw health check
# -------------------------------------------------------------------
if curl -sf http://127.0.0.1:18789/health > /dev/null 2>&1; then
  log "OK: OpenClaw is healthy"
else
  systemctl restart openclaw
  MSG="OpenClaw was unreachable and has been restarted"
  log "ALERT: ${MSG}"
  echo "${MSG}" | mail -s "VOLTAIRE ALERT: OpenClaw restarted" "${ALERT_EMAIL}"
fi

# -------------------------------------------------------------------
# 2. Disk space check
# -------------------------------------------------------------------
USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$USAGE" -gt 90 ]; then
  find ~/.openclaw/acpx/sessions/ -type f -mtime +7 -delete 2>/dev/null || true
  find ~/.openclaw/acpx/sessions/ -type d -empty -mtime +7 -delete 2>/dev/null || true
  find /tmp -type f -name "playwright-*" -mtime +1 -delete 2>/dev/null || true
  MSG="Disk at ${USAGE}%, cleaned old sessions and temp files"
  log "ALERT: ${MSG}"
  echo "${MSG}" | mail -s "VOLTAIRE DISK ALERT" "${ALERT_EMAIL}"
else
  log "OK: Disk usage at ${USAGE}%"
fi

# -------------------------------------------------------------------
# 3. ACPX session stuck detection (>30 minutes)
# -------------------------------------------------------------------
STUCK_SESSIONS=$(ps -eo pid,etimes,comm 2>/dev/null \
  | awk '$3 ~ /acpx/ && $2 > 1800 {print $1}' || true)

if [ -n "${STUCK_SESSIONS}" ]; then
  STUCK_COUNT=$(echo "${STUCK_SESSIONS}" | wc -l | tr -d ' ')
  MSG="${STUCK_COUNT} ACPX session(s) running longer than 30 minutes: PIDs ${STUCK_SESSIONS//$'\n'/, }"
  log "WARN: ${MSG}"
  echo "${MSG}" | mail -s "VOLTAIRE ALERT: Stuck ACPX sessions" "${ALERT_EMAIL}"
else
  log "OK: No stuck ACPX sessions"
fi

# -------------------------------------------------------------------
# 4. Notion ticket stuck detection (placeholder)
# -------------------------------------------------------------------
# TODO: Call OpenClaw HTTP API to query dispatch records for tickets
# stuck in "In Progress" status for >4 hours without a PR.
# Endpoint: GET http://127.0.0.1:18789/api/dispatches?status=in_progress
# For now, use ACPX process age as a proxy: sessions older than 4 hours
# likely indicate a stuck ticket.
VERY_OLD_SESSIONS=$(ps -eo pid,etimes,comm 2>/dev/null \
  | awk '$3 ~ /acpx/ && $2 > 14400 {print $1}' || true)

if [ -n "${VERY_OLD_SESSIONS}" ]; then
  OLD_COUNT=$(echo "${VERY_OLD_SESSIONS}" | wc -l | tr -d ' ')
  MSG="${OLD_COUNT} ACPX session(s) running longer than 4 hours (possible stuck ticket): PIDs ${VERY_OLD_SESSIONS//$'\n'/, }"
  log "WARN: ${MSG}"
  echo "${MSG}" | mail -s "VOLTAIRE ALERT: Possible stuck ticket" "${ALERT_EMAIL}"
else
  log "OK: No ACPX sessions older than 4 hours"
fi

# -------------------------------------------------------------------
# 5. CPU usage check (>90% for more than 5 minutes)
# -------------------------------------------------------------------
# etimes = elapsed time in seconds; filter processes alive >300s with CPU >90%
HIGH_CPU=$(ps -eo pid,etimes,%cpu,comm 2>/dev/null \
  | awk 'NR > 1 && $2 > 300 && $3 > 90.0 {printf "%s(%s, %.0f%%)\n", $4, $1, $3}' || true)

if [ -n "${HIGH_CPU}" ]; then
  MSG="Processes using >90% CPU for more than 5 minutes: ${HIGH_CPU//$'\n'/, }"
  log "WARN: ${MSG}"
  echo "${MSG}" | mail -s "VOLTAIRE ALERT: High CPU usage" "${ALERT_EMAIL}"
else
  log "OK: No processes with sustained high CPU usage"
fi

log "Watchdog run completed"
