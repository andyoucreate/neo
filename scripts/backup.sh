#!/bin/bash
# backup.sh — Daily backup of OpenClaw data and event journal
set -euo pipefail

BACKUP_DIR="/opt/voltaire/backups"
DATE=$(date +%Y-%m-%d)
BACKUP_PATH="${BACKUP_DIR}/${DATE}"
LOG_FILE="/opt/voltaire/backups/backup.log"

mkdir -p "${BACKUP_PATH}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "${LOG_FILE}"
}

log "Backup started"

# Backup OpenClaw data
if tar czf "${BACKUP_PATH}/openclaw.tar.gz" -C /home/voltaire .openclaw/ 2>/dev/null; then
  log "OpenClaw data backed up"
else
  log "ERROR: Failed to backup OpenClaw data"
fi

# Backup event journal
if tar czf "${BACKUP_PATH}/events.tar.gz" -C /opt/voltaire events/ 2>/dev/null; then
  log "Event journal backed up"
else
  log "ERROR: Failed to backup event journal"
fi

# Backup locks
if tar czf "${BACKUP_PATH}/locks.tar.gz" -C /opt/voltaire locks/ 2>/dev/null; then
  log "Locks backed up"
else
  log "ERROR: Failed to backup locks"
fi

# Retain last 30 days of backups
find "${BACKUP_DIR}" -maxdepth 1 -type d -mtime +30 -not -path "${BACKUP_DIR}" -exec rm -rf {} +

log "Backup completed"
