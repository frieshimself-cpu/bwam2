import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { RelaunchSettings } from "./config.js";
import { log, short, sleep } from "./log.js";
import {
  ESTIMATED_CREATE_COST_SOL,
  curveStats,
  describeParams,
  fetchExternalBuys,
  launchCoin,
  pumpUrl,
  type LaunchParams,
} from "./pump.js";

export interface Launch {
  index: number;
  mint: PublicKey;
  signature: string;
  at: number;
}

export interface WindowResult {
  buys: number;
  buyers: Set<string>;
  solRaised: number;
}

export interface RelaunchContext {
  connection: Connection;
  wallet: Keypair;
  params: LaunchParams;
  /** Read at the start of every window / launch so edits apply to the next step. */
  settings: () => RelaunchSettings;
  /** Aborting ends the loop at the next step. */
  signal?: AbortSignal;
  /** Called with a new mint before its transaction is sent. */
  onMint?: (mint: PublicKey) => void;
  /** Called when a launch is confirmed on-chain. */
  onLaunch?: (launch: Launch) => void;
  /** Called when a launch's watch window ends. */
  onWindow?: (launch: Launch, result: WindowResult) => void;
}

/** Watches one launch for `intervalSec`, returning early once `stopOnBuys` external buys land. */
export async function watchWindow(ctx: RelaunchContext, launch: Launch): Promise<WindowResult> {
  const { connection, wallet, signal } = ctx;
  const settings = ctx.settings();
  const deadline = Date.now() + settings.intervalSec * 1000;
  const seen = new Set<string>();
  const buyers = new Set<string>();
  let buys = 0;

  log.info(`watching launch #${launch.index} for ${settings.intervalSec}s — ${pumpUrl(launch.mint)}`);

  for (;;) {
    try {
      const fresh = await fetchExternalBuys({
        connection,
        mint: launch.mint,
        since: launch.signature,
        exclude: wallet.publicKey,
        seen,
      });
      for (const buy of fresh) {
        buys += 1;
        buyers.add(buy.user.toBase58());
        log.info(`  buy #${buys}: ${buy.sol.toFixed(4)} SOL from ${short(buy.user)}`);
      }
    } catch (err) {
      log.warn(`poll failed, will retry: ${(err as Error).message}`);
    }

    const hit = settings.stopOnBuys > 0 && buys >= settings.stopOnBuys;
    const remaining = deadline - Date.now();
    if (hit || remaining <= 0 || signal?.aborted) {
      let solRaised = 0;
      try {
        solRaised = (await curveStats(connection, launch.mint)).solRaised;
      } catch {
        // stats are informational only
      }
      return { buys, buyers, solRaised };
    }
    await sleep(Math.min(settings.pollSec * 1000, remaining), signal);
  }
}

/**
 * The relaunch loop. Starts from `first` (a coin that already exists) or by
 * launching one; after each launch waits `intervalSec` for outside buys and,
 * if there are not enough, launches the same coin again on a fresh mint — up
 * to `maxRelaunches` times.
 */
export async function relaunchUntilBought(ctx: RelaunchContext, first?: Launch): Promise<Launch[]> {
  const { params, signal } = ctx;
  const launches: Launch[] = [];
  const initial = ctx.settings();
  const totalLaunches = initial.maxRelaunches + (first ? 0 : 1);
  const perLaunch = ESTIMATED_CREATE_COST_SOL + initial.devBuySol + (initial.jitoUrl ? initial.jitoTipSol : 0);

  log.info(
    `plan: "${params.name}" ($${params.symbol}) ${describeParams(params)} — up to ${totalLaunches} launch(es), ` +
      `${initial.intervalSec}s window each, stop after ${initial.stopOnBuys || "∞"} outside buy(s), ` +
      `dev buy ${initial.devBuySol} SOL — worst case ≈${(totalLaunches * perLaunch).toFixed(3)} SOL` +
      (initial.dryRun ? " [DRY RUN]" : ""),
  );

  const launchNext = async (): Promise<Launch | null> => {
    const result = await launchCoin({
      connection: ctx.connection,
      wallet: ctx.wallet,
      params,
      settings: ctx.settings(),
      onMint: ctx.onMint,
    });
    if (!result) return null;
    const launch: Launch = { index: launches.length, mint: result.mint, signature: result.signature, at: Date.now() };
    launches.push(launch);
    ctx.onLaunch?.(launch);
    return launch;
  };

  let current: Launch | null = first ?? null;
  if (current) {
    launches.push(current);
    if (initial.instantCopy && initial.maxRelaunches > 0) {
      // Fire the first copy the moment the launch is seen; the window logic
      // below then applies to the copy, not to the original.
      log.info("instant copy: launching now");
      const next = await launchNext();
      if (!next) return launches; // dry run
      current = next;
    }
  } else {
    current = await launchNext();
    if (!current) return launches; // dry run
  }

  for (let relaunch = first && initial.instantCopy ? 1 : 0; ; relaunch++) {
    const result = await watchWindow(ctx, current);
    ctx.onWindow?.(current, result);
    const settings = ctx.settings();

    if (settings.stopOnBuys > 0 && result.buys >= settings.stopOnBuys) {
      log.info(
        `launch #${current.index} got ${result.buys} outside buy(s) from ${result.buyers.size} wallet(s), ` +
          `${result.solRaised.toFixed(4)} SOL on the curve — stopping here: ${pumpUrl(current.mint)}`,
      );
      return launches;
    }
    log.info(`launch #${current.index}: ${result.buys} outside buy(s) in the window`);

    if (signal?.aborted) {
      log.info("stopped");
      break;
    }
    if (relaunch >= settings.maxRelaunches) {
      log.info(`relaunch limit (${settings.maxRelaunches}) reached`);
      break;
    }
    log.info(`relaunching (${relaunch + 1}/${settings.maxRelaunches})…`);
    const next = await launchNext();
    if (!next) break; // dry run
    current = next;
  }

  log.info("summary:");
  for (const l of launches) log.info(`  #${l.index} ${pumpUrl(l.mint)}`);
  return launches;
}
