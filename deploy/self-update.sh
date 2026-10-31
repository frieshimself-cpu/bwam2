#!/usr/bin/env bash
# Pulls the latest code for the checked-out branch, installs and builds.
# Run by the backend's "Update" button (POST /api/update); the process then
# exits and systemd starts the new version. Runs as the service user.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "fetching origin/$BRANCH"
git fetch -q origin "$BRANCH"
git reset -q --hard "origin/$BRANCH"
echo "installing"
npm ci --no-audit --no-fund --loglevel=error 2>/dev/null || npm install --no-audit --no-fund --loglevel=error
echo "building"
npm run build >/dev/null
npm run build-extension >/dev/null 2>&1 || true
echo "updated to $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
