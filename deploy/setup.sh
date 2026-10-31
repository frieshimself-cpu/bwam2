#!/usr/bin/env bash
# One-command install on a fresh Ubuntu/Debian VPS. As root:
#
#   curl -fsSL https://raw.githubusercontent.com/frieshimself-cpu/bwam2/claude/laughing-faraday-t7oy24/deploy/setup.sh | bash
#
# Installs Node 22, clones the repo to /opt/pump-relauncher, asks for the Helius
# RPC URL, generates the launch wallet on the server (prints only its address —
# you fund it, nobody handles a private key), runs the backend as a systemd
# service that survives reboots, and — if you give a domain — puts Caddy in
# front for HTTPS. Idempotent: re-running updates the code and restarts;
# existing .env and wallet are kept.
#
# Non-interactive use: HELIUS_RPC_URL=... DOMAIN=... bash setup.sh
# (WALLET_PRIVATE_KEY=... too, to use a wallet you already have; API_TOKEN=... to
# choose the token; DOMAIN=auto for HTTPS on <ip>.sslip.io without owning a domain)
set -euo pipefail

REPO="${REPO:-https://github.com/frieshimself-cpu/bwam2.git}"
BRANCH="${BRANCH:-claude/laughing-faraday-t7oy24}"
APP="${APP:-/opt/pump-relauncher}"
SVC=pump-relauncher
RUN_USER=relauncher
DOMAIN="${DOMAIN:-}"
PORT=3210

[ "$(id -u)" = 0 ] || { echo "run as root (sudo -i), then run this again"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo ">> packages"
# On a fresh VPS, cloud-init / unattended-upgrades may still hold the apt lock.
for _ in $(seq 1 60); do
  fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 || break
  sleep 5
done
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg openssl >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  echo ">> node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin "$RUN_USER"

echo ">> code"
# The checkout is owned by the service user; git (as root) refuses it without this.
git config --global --add safe.directory "$APP" 2>/dev/null || true
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH"
  git -C "$APP" checkout -q "$BRANCH"
  git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$APP"
fi
cd "$APP"
npm ci --no-audit --no-fund --loglevel=error 2>/dev/null || npm install --no-audit --no-fund --loglevel=error
npm run build >/dev/null
mkdir -p data

# ask <prompt> <var> [hidden] — reads from the terminal even when the script is piped into bash
ask() {
  local prompt="$1" var="$2" hidden="${3:-}" value
  [ -z "${!var:-}" ] || return 0
  if [ -n "$hidden" ]; then
    read -rsp "$prompt" value < /dev/tty
    echo
  else
    read -rp "$prompt" value < /dev/tty
  fi
  printf -v "$var" '%s' "$value"
}

IP=$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

if [ ! -f .env ]; then
  echo
  echo "The Helius URL goes into $APP/.env now and nowhere else."
  ask "Helius RPC URL (https://mainnet.helius-rpc.com/?api-key=...): " HELIUS_RPC_URL
  case "$HELIUS_RPC_URL" in http*) ;; *) HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=$HELIUS_RPC_URL" ;; esac
  [ -n "$DOMAIN" ] || ask "Domain for HTTPS: type 'auto' for <ip>.sslip.io, your own domain, or blank for an SSH tunnel: " DOMAIN
  API_TOKEN="${API_TOKEN:-$(openssl rand -hex 24)}"
  (
    umask 077
    cat > .env <<EOF
HELIUS_RPC_URL=$HELIUS_RPC_URL
WALLET_PRIVATE_KEY=${WALLET_PRIVATE_KEY:-}
HOST=127.0.0.1
PORT=$PORT
API_TOKEN=$API_TOKEN
DATA_DIR=$APP/data
EOF
  )
fi
# DOMAIN=auto: a hostname that resolves to this server's IP, so Caddy can get a real certificate.
[ "$DOMAIN" != "auto" ] || DOMAIN="${IP//./-}.sslip.io"
# The launch wallet: generated here if .env has none; its secret never leaves this file.
LAUNCH_ADDR=$(node dist/keygen.js | sed -n 's/^launch wallet: \([A-Za-z0-9]*\).*/\1/p')
API_TOKEN=$(grep -E '^API_TOKEN=' .env | cut -d= -f2-)
chown -R "$RUN_USER:$RUN_USER" "$APP"
chmod 600 .env

echo ">> service"
install -m 644 deploy/$SVC.service /etc/systemd/system/$SVC.service
systemctl daemon-reload
systemctl enable -q "$SVC"
systemctl restart "$SVC"

if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null; then
    echo ">> caddy"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  sed "s/relaunch.example.com/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

sleep 3
if curl -fsS -H "Authorization: Bearer $API_TOKEN" "http://127.0.0.1:$PORT/api/state" >/dev/null; then
  echo ">> service is up"
else
  echo "!! service did not come up; last log lines:"
  journalctl -u "$SVC" -n 30 --no-pager
  exit 1
fi

echo
echo "================ pump-relauncher is running ================"
if [ -n "$DOMAIN" ]; then
  echo "Dashboard:  https://$DOMAIN"
else
  echo "Dashboard:  from your PC run    ssh -L $PORT:127.0.0.1:$PORT root@$IP"
  echo "            then open           http://127.0.0.1:$PORT"
fi
echo "API token:  $API_TOKEN   (the dashboard asks for it once; the extension popup has a field for it)"
echo "Launch wallet: $LAUNCH_ADDR   <- send ~0.1 SOL here; every launch costs about 0.03 SOL"
echo "Logs:       journalctl -u $SVC -f"
echo "Update:     re-run this script"
echo "Secrets:    $APP/.env"
echo
echo "To let Claude work on this server:  cd $APP && claude remote-control"
echo "============================================================"
