#!/usr/bin/env bash
# One-command setup on macOS / Linux / WSL. README.md "Mac, from zero" has the full paste sequence.
#   curl -fsSL https://raw.githubusercontent.com/frieshimself-cpu/bwam2/claude/laughing-faraday-t7oy24/scripts/bootstrap.sh | bash
# What it does: checks Node 22 and git, gets the repo into ~/pump-relauncher, installs, type-checks,
# builds the extension assets, writes .env, generates the launch wallet (prints only its address),
# and prints what to do next.
set -euo pipefail

DIR="${DIR:-$HOME/pump-relauncher}"
REPO="${REPO:-https://github.com/frieshimself-cpu/bwam2.git}"
BRANCH="${BRANCH:-claude/laughing-faraday-t7oy24}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/5  Checking Node and git"
command -v git >/dev/null || die "git is not installed. macOS: xcode-select --install   Linux: sudo apt install git"
command -v node >/dev/null || die "Node is not installed. Install Node 22 LTS from https://nodejs.org then re-run."
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) is too old; install Node 22 LTS from https://nodejs.org then re-run."
echo "node $(node -v), git $(git --version | cut -d' ' -f3)"

say "2/5  Getting the repo into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" pull -q --ff-only origin "$BRANCH" || true
else
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

say "3/5  Installing and checking"
npm install --silent --no-audit --no-fund
npm run typecheck --silent
npm run build-extension --silent >/dev/null

say "4/5  Writing .env and the launch wallet"
[ -f .env ] || cp .env.example .env
npm run keygen --silent
echo "(HELIUS_RPC_URL is still empty: Claude Code sets it with you in the next step)"

say "5/5  Done. Let Claude Code drive from here:"
cat <<EOF
  In this terminal:   cd $DIR && claude
  Then paste:         Read FIRST_PROMPT.md and follow it exactly.
  It sets the RPC, has you fund the launch wallet, starts the dashboard, loads the extension,
  does a dry run, then the first real relaunch — one step at a time.

  By hand instead:
  a) put your Helius RPC URL in $DIR/.env as HELIUS_RPC_URL
  b) send ~0.1 SOL to the launch wallet address printed above
  c) cd $DIR && npm run serve   then open http://127.0.0.1:3210
  d) Chrome -> chrome://extensions -> Developer mode -> Load unpacked -> $DIR/extension
EOF
