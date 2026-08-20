#!/bin/bash
# ============================================================
#  Mahajak Guest WiFi – Captive Portal Setup Script
#  Ubuntu Linux (VM: guestwifi-app / 172.15.0.21)
#  Run as root:  sudo bash install.sh
# ============================================================

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓] $1${NC}"; }
warn() { echo -e "${YELLOW}[!] $1${NC}"; }
err()  { echo -e "${RED}[✗] $1${NC}"; exit 1; }

echo ""
echo "============================================="
echo "  Mahajak Captive Portal – Install Script"
echo "============================================="
echo ""

# ─── 1. Update system ─────────────────────────────────────────────────────────
log "Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ─── 2. Install Node.js 20 LTS ────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  log "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  log "Node.js already installed: $(node -v)"
fi

# ─── 3. Install PM2 globally ──────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  log "Installing PM2..."
  npm install -g pm2
else
  log "PM2 already installed: $(pm2 -v)"
fi

# ─── 4. Install build tools (needed for better-sqlite3) ───────────────────────
log "Installing build tools..."
apt-get install -y build-essential python3 -qq

# ─── 5. Copy app files ────────────────────────────────────────────────────────
APP_DIR="/opt/captive-portal"
log "Setting up app directory: $APP_DIR"
mkdir -p "$APP_DIR"
mkdir -p /var/log/captive-portal

# Copy all files (run from directory containing install.sh)
cp -r ./* "$APP_DIR/"
cd "$APP_DIR"

# ─── 6. Install npm dependencies ──────────────────────────────────────────────
log "Installing npm dependencies..."
npm install --production

# ─── 7. Configure .env ────────────────────────────────────────────────────────
warn "Please edit /opt/captive-portal/.env to set:"
warn "  SESSION_SECRET  → random string"
warn "  ADMIN_PASSWORD  → strong password"

# ─── 8. Start with PM2 ────────────────────────────────────────────────────────
log "Starting captive portal with PM2..."
pm2 start ecosystem.config.js

# ─── 9. PM2 auto-start on boot ────────────────────────────────────────────────
log "Enabling PM2 startup on boot..."
pm2 startup systemd -u root --hp /root | tail -1 | bash || true
pm2 save

# ─── 10. Allow port 3000 through UFW ──────────────────────────────────────────
if command -v ufw &>/dev/null; then
  log "Opening firewall port 3000..."
  ufw allow 3000/tcp
fi

echo ""
echo "============================================="
log "Installation complete!"
echo ""
echo "  Portal URL : http://172.15.0.21:3000"
echo "  Admin URL  : http://172.15.0.21:3000/admin"
echo "  Admin user : admin"
echo "  Admin pass : Mahajak@2024  (change in .env)"
echo ""
warn "Next step: Configure FortiGate 200E captive portal"
warn "  to redirect guest HTTP to: http://172.15.0.21:3000"
echo "============================================="
echo ""
