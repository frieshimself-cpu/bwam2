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
  /** Unsubscribes and aborts any running relaunch loop. */
  stop(): Promise<void>;
}

export interface WatchOptions {
  connection: Connection;
  /** The wallet that sends the relaunches. */
  wallet: Keypair;
  /** The developer wallet to copy: every coin it creates on pump.fun is relaunched. */
  devWallet: PublicKey;
  settings: () => RelaunchSettings;
  /** Return false to skip a detected launch (e.g. another run is in progress elsewhere). */
  canStart?: () => boolean;
  onDetect?: (call: CreateCall, signature: string) => void;
  onLaunch?: (launch: Launch) => void;
  onWindow?: (launch: Launch, result: WindowResult) => void;
  onLaunchUpdate?: (launch: Launch) => void;
  onLoopEnd?: (launches: Launch[]) => void;
  /** The loop ended with an error before finishing (e.g. the wallet could not cover a launch). */
  onLoopError?: (error: Error) => void;
}

/**
 * Listens for coins `devWallet` creates on pump.fun (from the site or anything
 * else), copies every launch parameter from the create transaction, and runs
 * the relaunch loop from `wallet`.
 */
export function watchWallet(options: WatchOptions): WatchHandle {
  const { connection, wallet, devWallet, settings } = options;
  const ownMints = new Set<string>(); // coins this bot launched: never relaunch a relaunch
  const handled = new Set<string>();
  const abort = new AbortController();
  const followUps: Promise<void>[] = []; // fee split / OTC listing work that outlives its loop
  let busy = false;
  let running: Promise<unknown> | null = null;

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

        log.info(
          `detected launch by ${short(devWallet)}: "${created.name}" ($${created.symbol}) ${describeParams(created)} → ${pumpUrl(created.mint)}`,
        );
        if (busy || options.canStart?.() === false) {
          log.warn("a relaunch loop is already running; ignoring this launch");
          return;
        }
        options.onDetect?.(created, signature);

        busy = true;
        running = relaunchUntilBought(
          {
            connection,
            wallet,
            params: created,
            settings,
            signal: abort.signal,
            onMint: (mint) => ownMints.add(mint.toBase58()),
            onLaunch: options.onLaunch,
            onWindow: options.onWindow,
            onLaunchUpdate: options.onLaunchUpdate,
            followUps,
          },
          { index: 0, mint: created.mint, signature, at: Date.now(), uri: created.uri, notes: [] },
        )
          .then((launches) => options.onLoopEnd?.(launches))
          .catch((e: Error) => {
            log.error(`relaunch loop failed: ${e.message}`);
            options.onLoopError?.(e);
          })
          .finally(() => {
            busy = false;
            running = null;
            if (!abort.signal.aborted) log.info("back to watching");
          });
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
      await running?.catch(() => undefined);
      await Promise.allSettled(followUps);
      log.info(`stopped watching ${short(devWallet)}`);
    },
  };
}
