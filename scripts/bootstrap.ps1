# One-command setup on Windows (PowerShell). README.md "Windows, from zero" has the full paste sequence.
#   irm https://raw.githubusercontent.com/frieshimself-cpu/bwam2/claude/laughing-faraday-t7oy24/scripts/bootstrap.ps1 | iex
# What it does: checks Node 22 and git, gets the repo into $HOME\pump-relauncher, installs, type-checks,
# builds the extension assets, writes .env, generates the launch wallet (prints only its address),
# and prints what to do next.
# If PowerShell refuses to run a script file, first run:  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
param([string]$Dir = "$HOME\pump-relauncher")
# "Continue" on purpose: Windows PowerShell 5.1 can turn harmless npm/git stderr output into a terminating error under "Stop".
$ErrorActionPreference = "Continue"
$Repo = "https://github.com/frieshimself-cpu/bwam2.git"
$Branch = "claude/laughing-faraday-t7oy24"

function Say($m) { Write-Host "`n$m" -ForegroundColor White }
function Die($m) { Write-Host "`n$m" -ForegroundColor Red; exit 1 }

Say "1/5  Checking Node and git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "git is not installed (winget install -e --id Git.Git), then open a NEW PowerShell window and re-run." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node is not installed (winget install -e --id OpenJS.NodeJS.LTS), then open a NEW PowerShell window and re-run." }
$v = (node -v).TrimStart("v").Split(".")
if ([int]$v[0] -lt 22) { Die "Node $(node -v) is too old; install Node LTS (winget install -e --id OpenJS.NodeJS.LTS) and re-run in a new window." }
Write-Host "node $(node -v), git $((git --version) -replace 'git version ','')"

Say "2/5  Getting the repo into $Dir"
if (Test-Path "$Dir\.git") {
  git -C $Dir fetch -q origin $Branch
  git -C $Dir checkout -q $Branch
  git -C $Dir pull -q --ff-only origin $Branch
} else {
  git clone -q -b $Branch $Repo $Dir
}
if (-not (Test-Path "$Dir\package.json")) { Die "could not get the repo into $Dir (see the git error above)" }
Set-Location $Dir

Say "3/5  Installing and checking"
npm install --silent --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die "npm install failed - open Claude Code here (claude) and paste the error above." }
npm run typecheck --silent
if ($LASTEXITCODE -ne 0) { Die "type-check failed - open Claude Code here (claude) and paste the output above." }
npm run build-extension --silent | Out-Null

Say "4/5  Writing .env and the launch wallet"
if (-not (Test-Path ".env")) { Copy-Item .env.example .env }
npm run keygen --silent
Write-Host "(HELIUS_RPC_URL is still empty: Claude Code sets it with you in the next step)"

Say "5/5  Done. Let Claude Code drive from here:"
Write-Host @"
  In this window:   cd `$HOME\pump-relauncher; claude
  Then paste:       Read FIRST_PROMPT.md and follow it exactly.
  It sets the RPC, has you fund the launch wallet, starts the dashboard, loads the extension,
  does a dry run, then the first real relaunch - one step at a time.

  By hand instead:
  a) put your Helius RPC URL in $Dir\.env as HELIUS_RPC_URL
  b) send ~0.1 SOL to the launch wallet address printed above
  c) cd $Dir; npm run serve   then open http://127.0.0.1:3210
  d) Chrome -> chrome://extensions -> Developer mode -> Load unpacked -> $Dir\extension
"@
