# pump-relauncher

Copies a developer wallet's pump.fun launches and relaunches them until they
get buys.

Paste the wallet you launch from into the dashboard (or the extension popup).
From then on, every coin that wallet creates on pump.fun is copied **exactly** —
name, ticker, image, description and links (same metadata URI), the coin it is
paired with (SOL, a pump coin or a tokenized stock), the creator fee ("tax"),
and the cashback / holder-reward / mayhem flags — and launched again on a fresh
mint from a separate launch wallet. If nobody buys within a window, it launches
again, so the coin keeps reappearing at the top of the "new" feed. It stops as
soon as the current launch gets real buys from other wallets, so you never leave
buyers behind on an older mint.

Built on the official `@pump-fun/pump-sdk`, against your Helius RPC. Nothing
goes through third-party transaction APIs; the launch key never leaves the
backend.

## Windows, from zero (copy–paste, in order)

Press the Windows key, type `powershell`, press Enter (a normal window, not "as administrator"). Paste each block, press Enter, wait.

**1. Git, Node LTS, Claude Code** (Windows asks "allow this app to make changes?" — Yes):

```powershell
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
winget install -e --id Anthropic.ClaudeCode --accept-source-agreements --accept-package-agreements
```

Then **close that PowerShell window and open a new one** — the new programs are only on the path of a fresh window.

**2. Get the project, install, make the launch wallet:**

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
irm https://raw.githubusercontent.com/frieshimself-cpu/bwam2/claude/laughing-faraday-t7oy24/scripts/bootstrap.ps1 | iex
```

**3. Open Claude Code in the project** (first time: pick a theme, log in with your Claude account in the browser, answer "Yes, I trust this folder"):

```powershell
cd $HOME\pump-relauncher; claude
```

**4. Inside Claude Code, paste:**

```
Read FIRST_PROMPT.md and follow it exactly.
```

It sets your Helius RPC, has you fund the launch wallet (you only ever see its address), starts the dashboard, loads the extension, does a dry run, then the first real relaunch and the first watched launch — one step at a time. Press Shift+Tab once so the prompt says "accept edits"; when it asks permission to run a command, choose "don't ask again" for npm, node and git.

**Prefer the Claude desktop app?** Skip the `Anthropic.ClaudeCode` line in step 1, then instead of step 3 open the Claude app → **Code** tab → **Local** → **Select folder** → `pump-relauncher` in your home folder → permission mode **Accept edits** → paste the step-4 message.

## Mac, from zero

```bash
[ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ] || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

```bash
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
brew install node@22 && brew link --overwrite --force node@22
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

```bash
curl -fsSL https://raw.githubusercontent.com/frieshimself-cpu/bwam2/claude/laughing-faraday-t7oy24/scripts/bootstrap.sh | bash
```

```bash
cd ~/pump-relauncher && claude
```

Then paste `Read FIRST_PROMPT.md and follow it exactly.`

## One-command install on a server

On a fresh Ubuntu/Debian VPS, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/frieshimself-cpu/bwam2/claude/laughing-faraday-t7oy24/deploy/setup.sh | bash
```

It installs Node, the code and a systemd service, asks for your Helius RPC URL,
generates the launch wallet on the server (prints only the address for you to
fund; the secret stays in `/opt/pump-relauncher/.env`), optionally sets up
HTTPS with Caddy if you give it a domain, and prints the dashboard address and
an API token. Re-run it to update. Logs: `journalctl -u pump-relauncher -f`.

## Manual setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `HELIUS_RPC_URL` – your Helius mainnet RPC URL (the websocket URL is derived from it).
- `WALLET_PRIVATE_KEY` – the **launch wallet**, the one that sends the relaunches. `npm run keygen` generates one, writes it here and prints only the address to fund. The developer wallets you copy never need their keys.

Then start the backend:

```bash
npm run serve
```

The dashboard is at <http://127.0.0.1:3210>.

## Using it

The dashboard is one card:

1. **Wallets to copy** – paste the addresses of the wallets you launch from, one per line. Nothing needs importing; no keys.
2. **Dev buy (SOL)** – how much the copy buys in its own create transaction (0 = none).
3. **Test mode** – tick it to simulate every copy without sending anything; untick for real.
4. **Save & start.** From then on, launch on pump.fun from any of those wallets exactly as you normally do: the launch is detected within a second, its parameters are read from the create transaction, and the copy goes out from the launch wallet immediately. If the copy gets no outside buys within the window, it relaunches again, up to the configured number of copies. The current run and every mint it produced show up live, with pump.fun links.

**Advanced** (collapsed) holds the relaunch policy (copies per launch, wait between copies, stop-on-buys, instant copy), priority fee and Jito, **Relaunch an existing coin** (paste any pump.fun mint to copy it right now), the run history, and the **Update server** button.

### The extension

The popup is the same controls in compact form, talking to the backend.

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension/` folder.
2. Open the popup → **Backend** → the URL where `npm run serve` is running (default `http://127.0.0.1:3210`) and the API token if you set one → **Connect**.

After editing `web/app.js` or `web/style.css`, run `npm run build-extension` to copy them into `extension/`.

### Hosting the backend elsewhere

Set `HOST=0.0.0.0`, set an `API_TOKEN`, and put it behind HTTPS (Caddy, nginx). Enter that URL and token in the popup. Keep the launch key on that machine only.

## What gets copied

| From the original coin | Copied as |
| --- | --- |
| name, ticker | same |
| image, description, website / twitter / telegram | same metadata URI |
| quote pairing (SOL, pump coin, tokenized stock) | same quote mint, resolved through the SDK |
| creator fee bps ("tax") | same (while pump.fun has per-coin fees enabled) |
| holder-reward flag | same (while enabled on pump.fun) |
| mayhem mode | same |
| creator fee recipient | the original creator wallet receives the copy's creator fees too |
| fee split (up to 10 recipients) | recreated on the copy with the same recipients and percentages |
| donations (donate.gg) | a new donation escrow for the copy, same donate.gg config |
| cashback flag | pump.fun no longer allows cashback on new coins; dropped with a warning |

The fee split / donation setup is read from the original coin again right before every launch, since pump.fun's site sets it up a moment after the create.

A dev buy (`DEV_BUY_SOL`) is applied to SOL-quoted launches only; token-quoted launches are created without one.

Transactions are built as **version 1** transactions, the same kind pump.fun's site sends, so create + first buy + tip fit in one transaction without a lookup table.

## The loop

```
launch → watch RELAUNCH_INTERVAL_SEC for buys from other wallets
       ├─ ≥ RELAUNCH_STOP_ON_BUYS outside buys → stop, that coin is the one
       └─ not enough → relaunch (up to RELAUNCH_MAX times) → watch again
```

Buys are counted from the bonding curve's `TradeEvent`s, excluding the launch wallet, so a dev buy never counts as "attention".

| Setting | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `RELAUNCH_MAX` | `--max` | 3 | relaunches after the first launch |
| `RELAUNCH_INTERVAL_SEC` | `--interval` | 120 | seconds each launch gets to attract buys |
| `RELAUNCH_POLL_SEC` | `--poll` | 10 | seconds between curve checks |
| `RELAUNCH_STOP_ON_BUYS` | `--stop-on-buys` | 1 | outside buys that end the loop (0 = never stop early) |
| `INSTANT_COPY` | — | true | in watch mode, fire the first copy the moment a launch is detected instead of watching the original first |
| `DEV_BUY_SOL` | `--dev-buy` | 0 | SOL to buy in the same transaction as the create |
| `PRIORITY_FEE_MICROLAMPORTS` | `--priority-fee` | 100000 | priority fee per compute unit |
| `JITO_URL` | `--jito` | off | send through a Jito block engine (with a tip) instead of the RPC |
| `JITO_TIP_SOL` | `--jito-tip` | 0.001 | Jito tip per launch |
| `DRY_RUN` | `--dry-run` | false | build and simulate the create, send nothing |

All of these are editable live in the dashboard; changes apply to the next launch or window.

## CLI

Everything the dashboard does is also a command:

```bash
npm run watch -- <developer wallet>     # copy that wallet's launches (Ctrl+C to stop)
npm run relaunch -- <mint>              # copy an existing coin now
npm run launch -- token.json            # launch from a config file (uploads image + metadata), then loop
npm run status -- <mint>                # parameters, curve and recent buys of a coin
```

`token.json` takes `name`, `symbol`, `description`, `image` (file or URL), optional links, and the launch parameters (`mayhemMode`, `creatorFeeBps`, `holderReward`, `quoteMint`). Set `"uri"` to reuse metadata you already uploaded.

Try anything with `--dry-run` (or the Dry run checkbox) first: it builds and simulates the launch and sends nothing.

## Costs and caveats

- Each launch costs roughly 0.02–0.03 SOL in rent and fees, plus `DEV_BUY_SOL` and any Jito tip. The dashboard shows the worst-case total for the current settings, and the backend refuses to launch when the wallet can't cover one launch.
- Repeated identical launches are visible to everyone and pump.fun's feed may de-rank or flag duplicates. Keep the relaunch count and interval reasonable.
- pump.fun's IPFS upload endpoint (used only by `launch token.json`) sits behind Cloudflare and sometimes rejects server-side requests. Copying a launch never uploads anything — it reuses the original metadata URI.
- One run at a time: a second launch from the developer wallet while a run is in progress is logged and ignored.
