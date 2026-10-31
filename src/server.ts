// Dashboard + API for the website and the extension popup. Holds the launch
// wallet, keeps the watcher alive, streams the log, and persists the chosen
// developer wallet, settings and run history under DATA_DIR.
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { mergeSettings, serverSettingsFromEnv, type RelaunchSettings } from "./config.js";
import { log, onLog, recentLogs } from "./log.js";
import { paramsFromMint } from "./metadata.js";
import { describeParams, pumpUrl, type LaunchParams } from "./pump.js";
import { relaunchUntilBought, type Launch, type WindowResult } from "./relaunch.js";
import { makeConnection } from "./rpc.js";
import { loadWallet } from "./wallet.js";
import { watchWallet, type WatchHandle } from "./watch.js";

interface LaunchJson {
  index: number;
  mint: string;
  url: string;
  signature: string;
  at: number;
}

interface WindowJson {
  index: number;
  buys: number;
  buyers: number;
  solRaised: number;
}

export interface RunRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  /** "watch" when triggered by the developer wallet, "manual" for a relaunch from the UI/CLI. */
  trigger: "watch" | "manual";
  devWallet?: string;
  source: { mint: string; url: string; name: string; symbol: string; summary: string; params: LaunchParams };
  launches: LaunchJson[];
  windows: WindowJson[];
  outcome?: "bought" | "exhausted" | "stopped" | "dry-run" | "error";
  error?: string;
}

interface PersistedState {
  /** Developer wallets to copy. */
  devWallets: string[];
  /** @deprecated single-wallet field from earlier versions */
  devWallet?: string | null;
  /** Resume watching after a restart or reboot. */
  watching: boolean;
  settings: RelaunchSettings;
  history: RunRecord[];
}

const execFileAsync = promisify(execFile);

const HISTORY_LIMIT = 50;
const VERSION = "2026-10-31.7";
const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function launchJson(launch: Launch): LaunchJson {
  return { index: launch.index, mint: launch.mint.toBase58(), url: pumpUrl(launch.mint), signature: launch.signature, at: launch.at };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export async function startServer(initialSettings: RelaunchSettings): Promise<void> {
  const srv = serverSettingsFromEnv();
  const dataFile = resolve(srv.dataDir, "state.json");
  const rootDir = resolve(__dirname, "..");
  const webDir = resolve(rootDir, "web");
  let updating = false;
  let resumeWatching = false;

  // ---- state ---------------------------------------------------------------
  let settings = initialSettings;
  let devWallets: PublicKey[] = [];
  let history: RunRecord[] = [];
  let current: RunRecord | null = null;
  let watchers: WatchHandle[] = [];
  let watchStopped = false; // set before stopping the watcher so its run is recorded as "stopped"
  let manual: AbortController | null = null;
  let balanceCache: { at: number; sol: number } | null = null;
  const sseClients = new Set<ServerResponse>();

  let connection: Connection | null = null;
  let rpcError = "";
  try {
    connection = makeConnection();
  } catch (err) {
    rpcError = (err as Error).message;
  }

  let launcher: Keypair | null = null;
  let launcherError = "";
  try {
    launcher = loadWallet();
  } catch (err) {
    launcherError = (err as Error).message;
  }

  try {
    const saved = JSON.parse(await readFile(dataFile, "utf8")) as Partial<PersistedState>;
    const savedWallets = Array.isArray(saved.devWallets) ? saved.devWallets : saved.devWallet ? [saved.devWallet] : [];
    devWallets = savedWallets.map((w) => new PublicKey(w));
    if (saved.settings) settings = mergeSettings(settings, saved.settings);
    if (Array.isArray(saved.history)) history = saved.history.slice(-HISTORY_LIMIT);
    resumeWatching = saved.watching === true;
  } catch {
    // first run
  }

  async function persist() {
    await mkdir(srv.dataDir, { recursive: true });
    const state: PersistedState = {
      devWallets: devWallets.map((w) => w.toBase58()),
      watching: watchers.length > 0,
      settings,
      history,
    };
    await writeFile(dataFile, JSON.stringify(state, null, 2));
  }

  async function launcherBalance(): Promise<number | null> {
    if (!connection || !launcher) return null;
    if (balanceCache && Date.now() - balanceCache.at < 10_000) return balanceCache.sol;
    try {
      const sol = (await connection.getBalance(launcher.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
      balanceCache = { at: Date.now(), sol };
      return sol;
    } catch {
      return balanceCache?.sol ?? null;
    }
  }

  async function stateJson() {
    return {
      rpc: { ok: !!connection, error: rpcError },
      launcher: launcher ? { address: launcher.publicKey.toBase58(), balanceSol: await launcherBalance() } : null,
      launcherError,
      devWallets: devWallets.map((w) => w.toBase58()),
      watching: watchers.length > 0,
      busy: !!current,
      updating,
      version: VERSION,
      settings,
      current,
      history: [...history].reverse(),
      logs: recentLogs(200),
    };
  }

  function broadcast(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) client.write(payload);
  }
  const broadcastState = () => void stateJson().then((s) => broadcast("state", s));
  onLog((entry) => broadcast("log", entry));

  // ---- runs ----------------------------------------------------------------
  function beginRun(trigger: RunRecord["trigger"], params: LaunchParams, sourceMint: PublicKey | null, dev?: PublicKey): RunRecord {
    current = {
      id: `${Date.now().toString(36)}`,
      startedAt: Date.now(),
      trigger,
      devWallet: dev?.toBase58(),
      source: {
        mint: sourceMint?.toBase58() ?? "",
        url: sourceMint ? pumpUrl(sourceMint) : "",
        name: params.name,
        symbol: params.symbol,
        summary: describeParams(params),
        params,
      },
      launches: [],
      windows: [],
    };
    broadcastState();
    return current;
  }

  const onLaunch = (launch: Launch) => {
    current?.launches.push(launchJson(launch));
    broadcastState();
  };
  const onWindow = (launch: Launch, result: WindowResult) => {
    current?.windows.push({ index: launch.index, buys: result.buys, buyers: result.buyers.size, solRaised: result.solRaised });
    broadcastState();
  };

  async function endRun(outcome: RunRecord["outcome"], error?: string) {
    if (!current) return;
    current.endedAt = Date.now();
    current.outcome = outcome;
    if (error) current.error = error;
    history.push(current);
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    current = null;
    balanceCache = null;
    await persist();
    broadcastState();
  }

  function outcomeOf(record: RunRecord, aborted: boolean): RunRecord["outcome"] {
    if (settings.dryRun) return "dry-run";
    const last = record.windows[record.windows.length - 1];
    if (last && settings.stopOnBuys > 0 && last.buys >= settings.stopOnBuys) return "bought";
    return aborted ? "stopped" : "exhausted";
  }

  function startWatching() {
    if (!connection) throw new HttpError(400, `RPC not configured: ${rpcError}`);
    if (!launcher) throw new HttpError(400, `launch wallet not configured: ${launcherError}`);
    if (devWallets.length === 0) throw new HttpError(400, "add at least one wallet to copy first");
    const rpc = connection;
    const wallet = launcher;
    watchStopped = false;
    watchers = devWallets.map((dev) =>
      watchWallet({
        connection: rpc,
        wallet,
        devWallet: dev,
        settings: () => settings,
        canStart: () => !current,
        onDetect: (call, signature) => {
          const run = beginRun("watch", call, call.mint, dev);
          // the original launch is launch #0 of the run
          run.launches.push({ index: 0, mint: call.mint.toBase58(), url: pumpUrl(call.mint), signature, at: Date.now() });
        },
        onLaunch,
        onWindow,
        onLoopEnd: () => void endRun(current ? outcomeOf(current, watchStopped) : undefined),
      }),
    );
    void persist();
    broadcastState();
  }

  /** `forRestart` keeps the persisted watching flag so the next start resumes watching. */
  async function stopWatching(forRestart = false) {
    const stopping = watchers;
    watchers = [];
    if (stopping.length) {
      watchStopped = true;
      await Promise.all(stopping.map((w) => w.stop())); // runs onLoopEnd for an in-progress run
    }
    if (!forRestart) await persist();
    broadcastState();
  }

  /** Replaces the list of wallets to copy; restarts the watchers if they were running. */
  async function setDevWallets(raw: unknown) {
    const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/))
      .map((v) => String(v).trim())
      .filter(Boolean);
    const next: PublicKey[] = [];
    for (const value of list) {
      try {
        const key = new PublicKey(value);
        if (!next.some((k) => k.equals(key))) next.push(key);
      } catch {
        throw new HttpError(400, `not a valid Solana address: ${value}`);
      }
    }
    const wasWatching = watchers.length > 0;
    if (wasWatching) await stopWatching();
    devWallets = next;
    await persist();
    log.info(next.length ? `wallets to copy: ${next.map((k) => k.toBase58()).join(", ")}` : "wallets to copy cleared");
    if (wasWatching && next.length) startWatching();
  }

  /** Pulls the latest code, builds it and exits; systemd starts the new version. */
  async function selfUpdate() {
    if (updating) throw new HttpError(409, "an update is already running");
    if (current) throw new HttpError(409, "a run is in progress; stop it first");
    updating = true;
    broadcastState();
    log.info("updating from GitHub…");
    try {
      const { stdout, stderr } = await execFileAsync("bash", [resolve(rootDir, "deploy", "self-update.sh")], {
        cwd: rootDir,
        timeout: 15 * 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      for (const line of `${stdout}\n${stderr}`.split("\n").filter(Boolean)) log.info(`  ${line}`);
    } catch (err) {
      updating = false;
      const e = err as Error & { stdout?: string; stderr?: string };
      for (const line of `${e.stdout ?? ""}\n${e.stderr ?? ""}`.split("\n").filter(Boolean).slice(-10)) log.error(`  ${line}`);
      log.error(`update failed: ${e.message} — still running the previous version`);
      broadcastState();
      throw new HttpError(500, "update failed; see the log");
    }
    log.info("restarting with the new version…");
    broadcastState();
    setTimeout(() => {
      void stopWatching(true).finally(() => process.exit(0));
    }, 500);
  }

  async function relaunchManual(mint: PublicKey) {
    if (!connection) throw new HttpError(400, `RPC not configured: ${rpcError}`);
    if (!launcher) throw new HttpError(400, `launch wallet not configured: ${launcherError}`);
    if (current) throw new HttpError(409, "a run is already in progress");
    const params = await paramsFromMint(connection, mint);
    const record = beginRun("manual", params, mint);
    manual = new AbortController();
    const signal = manual.signal;
    void relaunchUntilBought({ connection, wallet: launcher, params, settings: () => settings, signal, onLaunch, onWindow })
      .then(() => endRun(outcomeOf(record, signal.aborted)))
      .catch((err: Error) => {
        log.error(`relaunch failed: ${err.message}`);
        return endRun("error", err.message);
      })
      .finally(() => {
        manual = null;
      });
  }

  async function stopRun() {
    if (manual) {
      manual.abort();
      return;
    }
    if (watchers.length && current) {
      // the watcher's loop shares its abort signal: restart the watchers to end the loop only
      await stopWatching();
      startWatching();
    }
  }

  // ---- http ----------------------------------------------------------------
  function authorized(req: IncomingMessage, url: URL): boolean {
    if (!srv.apiToken) return true;
    return req.headers.authorization === `Bearer ${srv.apiToken}` || url.searchParams.get("token") === srv.apiToken;
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    if (file.includes("..") || file.includes("/")) throw new HttpError(404, "not found");
    const type = STATIC_TYPES[extname(file)];
    if (!type) throw new HttpError(404, "not found");
    let body: Buffer;
    try {
      body = await readFile(resolve(webDir, file));
    } catch {
      throw new HttpError(404, "not found");
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(body);
  }

  async function handleApi(req: IncomingMessage, url: URL, res: ServerResponse): Promise<unknown> {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/state":
        return stateJson();
      case "GET /api/events": {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        res.write(`event: state\ndata: ${JSON.stringify(await stateJson())}\n\n`);
        sseClients.add(res);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
        return undefined; // stream stays open
      }
      case "POST /api/dev-wallets": {
        const body = await readJsonBody(req);
        await setDevWallets(body.addresses);
        return stateJson();
      }
      case "POST /api/dev-wallet": {
        // earlier single-wallet form of the call above
        const body = await readJsonBody(req);
        await setDevWallets(typeof body.address === "string" ? [body.address] : []);
        return stateJson();
      }
      case "POST /api/settings": {
        const body = await readJsonBody(req);
        try {
          settings = mergeSettings(settings, body);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        await persist();
        log.info("settings saved");
        return stateJson();
      }
      case "POST /api/watch": {
        const body = await readJsonBody(req);
        if (body.on === false) await stopWatching();
        else if (watchers.length === 0) startWatching();
        return stateJson();
      }
      case "POST /api/relaunch": {
        const body = await readJsonBody(req);
        let mint: PublicKey;
        try {
          mint = new PublicKey(String(body.mint ?? "").trim());
        } catch {
          throw new HttpError(400, "not a valid mint address");
        }
        await relaunchManual(mint);
        return stateJson();
      }
      case "POST /api/stop": {
        await stopRun();
        return stateJson();
      }
      case "POST /api/update": {
        await selfUpdate();
        return stateJson();
      }
      default:
        throw new HttpError(404, "not found");
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (url.pathname.startsWith("/api/")) {
        if (!authorized(req, url)) throw new HttpError(401, "unauthorized");
        const result = await handleApi(req, url, res);
        if (result === undefined) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log.error(`${req.method} ${url.pathname}: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  await new Promise<void>((resolveListen) => server.listen(srv.port, srv.host, resolveListen));
  log.info(`dashboard on http://${srv.host}:${srv.port}${srv.apiToken ? " (API token required)" : ""} — version ${VERSION}`);
  if (rpcError) log.warn(`RPC not configured: ${rpcError}`);
  if (launcherError) log.warn(`launch wallet not configured: ${launcherError}`);
  if (devWallets.length) log.info(`wallets to copy: ${devWallets.map((w) => w.toBase58()).join(", ")}`);
  if (resumeWatching && devWallets.length && connection && launcher) {
    try {
      startWatching();
    } catch (err) {
      log.warn(`could not resume watching: ${(err as Error).message}`);
    }
  }

  const shutdown = () => {
    void stopWatching(true).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
