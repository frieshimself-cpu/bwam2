import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

export interface RelaunchSettings {
  /** Relaunches after the first launch. */
  maxRelaunches: number;
  /** Seconds each launch gets to attract buys before the next relaunch. */
  intervalSec: number;
  /** Seconds between bonding-curve checks inside that window. */
  pollSec: number;
  /** External buys that count as "it worked" (0 = never stop early). */
  stopOnBuys: number;
  /** SOL bought in the same transaction as the create (0 = create only). */
  devBuySol: number;
  /** Priority fee, micro-lamports per compute unit. */
  priorityFeeMicroLamports: number;
  /** Build + simulate the launch transaction, never send it. */
  dryRun: boolean;
  /** Jito block-engine URL; empty = send through the RPC. */
  jitoUrl: string;
  /** Tip in SOL added to the transaction when sending through Jito. */
  jitoTipSol: number;
}

// Same block engine Velo uses; Frankfurt is a few ms from a German VPS.
export const DEFAULT_JITO_URL = "https://frankfurt.mainnet.block-engine.jito.wtf";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

export function settingsFromEnv(): RelaunchSettings {
  return {
    maxRelaunches: num("RELAUNCH_MAX", 3),
    intervalSec: num("RELAUNCH_INTERVAL_SEC", 120),
    pollSec: num("RELAUNCH_POLL_SEC", 10),
    stopOnBuys: num("RELAUNCH_STOP_ON_BUYS", 1),
    devBuySol: num("DEV_BUY_SOL", 0),
    priorityFeeMicroLamports: num("PRIORITY_FEE_MICROLAMPORTS", 100_000),
    dryRun: bool("DRY_RUN", false),
    jitoUrl: process.env.JITO_URL?.trim() ?? "",
    jitoTipSol: num("JITO_TIP_SOL", 0.001),
  };
}

/**
 * Applies a partial, untrusted settings object (from the dashboard or the
 * CLI) on top of `base`, keeping only known keys with valid values.
 */
export function mergeSettings(base: RelaunchSettings, patch: unknown): RelaunchSettings {
  const p = (patch ?? {}) as Record<string, unknown>;
  const numeric = (key: keyof RelaunchSettings, fallback: number) => {
    const raw = p[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
    return value;
  };
  const boolean = (key: keyof RelaunchSettings, fallback: boolean) => {
    const raw = p[key];
    if (raw === undefined || raw === null || raw === "") return fallback;
    return raw === true || raw === "true" || raw === 1 || raw === "1";
  };
  const text = (key: keyof RelaunchSettings, fallback: string) =>
    typeof p[key] === "string" ? (p[key] as string).trim() : fallback;

  return {
    maxRelaunches: Math.floor(numeric("maxRelaunches", base.maxRelaunches)),
    intervalSec: numeric("intervalSec", base.intervalSec),
    pollSec: Math.max(2, numeric("pollSec", base.pollSec)),
    stopOnBuys: Math.floor(numeric("stopOnBuys", base.stopOnBuys)),
    devBuySol: numeric("devBuySol", base.devBuySol),
    priorityFeeMicroLamports: Math.floor(numeric("priorityFeeMicroLamports", base.priorityFeeMicroLamports)),
    dryRun: boolean("dryRun", base.dryRun),
    jitoUrl: text("jitoUrl", base.jitoUrl),
    jitoTipSol: numeric("jitoTipSol", base.jitoTipSol),
  };
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  return value;
}

export function rpcUrls(): { http: string; ws: string } {
  let http = requireEnv("HELIUS_RPC_URL");
  // A bare Helius API key is accepted and expanded to the standard mainnet URL.
  if (!/^https?:\/\//i.test(http)) http = `https://mainnet.helius-rpc.com/?api-key=${http}`;
  const ws = process.env.HELIUS_WS_URL?.trim() || http.replace(/^http/, "ws");
  return { http, ws };
}

export interface ServerSettings {
  host: string;
  port: number;
  /** When set, every API call must carry `Authorization: Bearer <token>`. */
  apiToken: string;
  /** Where the dashboard's state (developer wallet, settings, history) is kept. */
  dataDir: string;
}

export function serverSettingsFromEnv(): ServerSettings {
  return {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: num("PORT", 3210),
    apiToken: process.env.API_TOKEN?.trim() ?? "",
    dataDir: process.env.DATA_DIR?.trim() || "data",
  };
}
