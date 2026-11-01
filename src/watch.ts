import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { chainCache } from "./cache.js";
import type { RelaunchSettings } from "./config.js";
import { log, short } from "./log.js";
import { createCallFromLogs, createCallIn, describeParams, pumpUrl, type CreateCall } from "./pump.js";
import { relaunchUntilBought, type Launch, type WindowResult } from "./relaunch.js";
import { getParsedTx } from "./rpc.js";

const CREATE_LOG = /Instruction: Create(V2)?\s*$/;

export interface WatchHandle {
  readonly devWallet: PublicKey;
  /** Unsubscribes and aborts every relaunch loop this watcher started. */
  stop(): Promise<void>;
}

/** Callbacks for one detected launch's relaunch loop. */
export interface RunHooks {
  onLaunch?: (launch: Launch) => void;
  onWindow?: (launch: Launch, result: WindowResult) => void;
  onLaunchUpdate?: (launch: Launch) => void;
  onLoopEnd?: (launches: Launch[]) => void;
  /** The loop ended with an error before finishing (e.g. the wallet could not cover a launch). */
  onLoopError?: (error: Error) => void;
}

export interface WatchOptions {
  connection: Connection;
  /** The wallet that sends the relaunches. */
  wallet: Keypair;
  /** The developer wallet to copy: every coin it creates on pump.fun is relaunched. */
  devWallet: PublicKey;
  settings: () => RelaunchSettings;
  /**
   * Mints this process launched, shared by every watcher: a copy is never
   * copied again, even when the launch wallet is itself one of the watched
   * wallets.
   */
  ownMints?: Set<string>;
  /**
   * A launch was detected and its loop is about to start. `abort` ends that
   * loop alone. Returns the callbacks for the loop.
   */
  onDetect?: (call: CreateCall, signature: string, abort: AbortController) => RunHooks | void;
}

/**
 * Listens for coins `devWallet` creates on pump.fun (from the site or anything
 * else), copies every launch parameter from the create transaction, and runs
 * the relaunch loop from `wallet`. Every launch gets its own loop, so launches
 * that follow each other quickly are all copied, side by side.
 */
export function watchWallet(options: WatchOptions): WatchHandle {
  const { connection, wallet, devWallet, settings } = options;
  const ownMints = options.ownMints ?? new Set<string>();
  const handled = new Set<string>();
  const abort = new AbortController();
  const followUps: Promise<void>[] = []; // fee split / OTC listing work that outlives its loop
  const running = new Set<Promise<void>>();

  const programId = PUMP_PROGRAM_ID.toBase58();
  // keep blockhash, program state and the launch wallet's balance warm so a
  // detected launch is copied without waiting on the RPC
  chainCache(connection).startRefreshing(wallet.publicKey);

  const subscription = connection.onLogs(
    devWallet,
    async ({ signature, err, logs }) => {
      if (err || abort.signal.aborted || handled.has(signature)) return;
      handled.add(signature);
      if (!logs.some((l) => l.includes(programId)) || !logs.some((l) => CREATE_LOG.test(l))) return;

      try {
        // Fast path: the CreateEvent is in the notification's logs, so there is
        // nothing to fetch. Fall back to the parsed transaction if it is missing.
        let created = createCallFromLogs(logs);
        if (!created) {
          const tx = await getParsedTx(connection, signature);
          created = tx && createCallIn(tx);
        }
        if (!created || !created.user.equals(devWallet)) return;
        if (ownMints.has(created.mint.toBase58())) return;
        if (abort.signal.aborted) return;

        log.info(
          `detected launch by ${short(devWallet)}: "${created.name}" ($${created.symbol}) ${describeParams(created)} → ${pumpUrl(created.mint)}`,
        );

        // This loop's own abort, also fired when the watcher stops.
        const loopAbort = new AbortController();
        const forward = () => loopAbort.abort();
        abort.signal.addEventListener("abort", forward, { once: true });
        const hooks = options.onDetect?.(created, signature, loopAbort) || {};
        const symbol = created.symbol;

        const loop: Promise<void> = relaunchUntilBought(
          {
            connection,
            wallet,
            params: created,
            settings,
            signal: loopAbort.signal,
            onMint: (mint) => ownMints.add(mint.toBase58()),
            onLaunch: hooks.onLaunch,
            onWindow: hooks.onWindow,
            onLaunchUpdate: hooks.onLaunchUpdate,
            followUps,
          },
          { index: 0, mint: created.mint, signature, at: Date.now(), uri: created.uri, notes: [] },
        )
          .then((launches) => hooks.onLoopEnd?.(launches))
          .catch((e: Error) => {
            log.error(`$${symbol}: relaunch loop failed: ${e.message}`);
            hooks.onLoopError?.(e);
          })
          .finally(() => {
            abort.signal.removeEventListener("abort", forward);
            running.delete(loop);
            if (!abort.signal.aborted) log.info(`$${symbol}: run finished; still watching ${short(devWallet)}`);
          });
        running.add(loop);
      } catch (e) {
        log.error(`handling ${signature} failed: ${(e as Error).message}`);
      }
    },
    // "processed": act as soon as a validator has executed the launch, about a
    // second before it is confirmed. A processed transaction can in rare cases
    // be dropped; the copy then simply has no original, which costs one launch.
    "processed",
  );

  log.info(`watching ${short(devWallet)} for pump.fun launches; relaunches go out from ${short(wallet.publicKey)}`);

  return {
    devWallet,
    async stop() {
      abort.abort();
      chainCache(connection).stopRefreshing();
      await connection.removeOnLogsListener(subscription).catch(() => undefined);
      await Promise.allSettled([...running]);
      await Promise.allSettled(followUps);
      log.info(`stopped watching ${short(devWallet)}`);
    },
  };
}
