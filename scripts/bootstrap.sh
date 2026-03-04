#!/bin/bash
# bootstrap.sh — OVH Advance-5, Ubuntu 24.04 LTS
set -euo pipefail

echo "=== Voltaire Network Bootstrap ==="

# 1. Non-root user
useradd -m -s /bin/bash voltaire

# 2. System updates + essentials
apt update && apt upgrade -y
apt install -y git curl wget jq unzip build-essential \
  nginx certbot python3-certbot-nginx \
  sqlite3 bubblewrap

# 3. Node.js 22 LTS (official APT repo — no curl|bash)
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
  gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | \
  tee /etc/apt/sources.list.d/nodesource.list > /dev/null
apt update && apt install -y nodejs

# 4. Claude Code CLI
npm install -g @anthropic-ai/claude-code
CLAUDE_BIN=$(which claude 2>/dev/null || echo "/usr/local/bin/claude")
echo "Claude Code installed at: $CLAUDE_BIN"
if [ ! -x "$CLAUDE_BIN" ]; then
  echo "WARNING: Claude Code binary not found at $CLAUDE_BIN"
fi

# 5. OpenClaw
npm install -g openclaw@latest

# 6. pnpm (required for dispatch-service)
npm install -g pnpm

# 7. Mail utilities (for watchdog alerts independent of Slack)
apt install -y mailutils

# 8. Playwright browsers
su - voltaire -c "npx playwright install --with-deps chromium"

# 9. GitHub CLI
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
  dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
  tee /etc/apt/sources.list.d/github-cli.list > /dev/null
apt update && apt install -y gh

# 10. Firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP (redirect to HTTPS)
ufw allow 443/tcp  # HTTPS
ufw --force enable

# 11. Directory structure
mkdir -p /opt/voltaire/{backups,scripts,events,locks,costs,logs}
chown -R voltaire:voltaire /opt/voltaire

# 12. .env files with correct permissions (readable by voltaire via group)
# Shared env (no ANTHROPIC_API_KEY — dispatch uses claude login credentials)
touch /opt/voltaire/.env
chown root:voltaire /opt/voltaire/.env
chmod 640 /opt/voltaire/.env

# OpenClaw-specific env (holds ANTHROPIC_API_KEY for OpenClaw agents only)
touch /opt/voltaire/.env.openclaw
chown root:voltaire /opt/voltaire/.env.openclaw
chmod 640 /opt/voltaire/.env.openclaw

# Write CLAUDE_CODE_PATH to .env (resolved from step 4)
if ! grep -q "CLAUDE_CODE_PATH" /opt/voltaire/.env 2>/dev/null; then
  echo "CLAUDE_CODE_PATH=$CLAUDE_BIN" >> /opt/voltaire/.env
fi

# 12b. Claude Code credentials for dispatch service (Agent SDK)
echo "Setting up Claude Code CLI credentials for voltaire user..."
su - voltaire -c "claude login"

# 13. Clone repo + build dispatch-service
REPO_DIR=/home/voltaire/repos/voltaire-network
if [ ! -d "$REPO_DIR/.git" ]; then
  su - voltaire -c "mkdir -p /home/voltaire/repos"
  su - voltaire -c "git clone git@github.com:andyoucreate/voltaire-network.git $REPO_DIR"
fi
su - voltaire -c "cd $REPO_DIR/dispatch-service && pnpm install --frozen-lockfile && pnpm build"

# Symlink so systemd WorkingDirectory resolves correctly
ln -sfn "$REPO_DIR/dispatch-service" /opt/voltaire/dispatch-service

# 14. Logrotate config
cat > /etc/logrotate.d/voltaire << 'LOGROTATE'
/home/voltaire/.openclaw/logs/*.log
/opt/voltaire/events/*.jsonl
/opt/voltaire/logs/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGROTATE

# 15. Systemd services
cp /opt/voltaire/scripts/openclaw.service /etc/systemd/system/
cp "$REPO_DIR/dispatch-service/voltaire-dispatch.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable openclaw voltaire-dispatch

# 16. System watchdog + backup cron
(echo "*/5 * * * * /opt/voltaire/scripts/watchdog.sh"; echo "0 3 * * * /opt/voltaire/scripts/backup.sh") | crontab -u voltaire -

# 17. TLS via Let's Encrypt
# certbot --nginx -d voltaire.yourdomain.com

echo "=== Bootstrap complete ==="
echo "Next steps:"
echo "1. Fill /opt/voltaire/.env with shared config (DISPATCH_AUTH_TOKEN, tokens, etc.)"
echo "   Fill /opt/voltaire/.env.openclaw with ANTHROPIC_API_KEY (for OpenClaw only)"
echo "2. Configure /home/voltaire/.openclaw/openclaw.json"
echo "3. Create GitHub bot account (voltaire-bot) and add SSH key"
echo "4. Start: systemctl start openclaw voltaire-dispatch"
