import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import type { RelaunchSettings } from "./config.js";
import { log, short } from "./log.js";
import { createCallIn, describeParams, pumpUrl, type CreateCall } from "./pump.js";
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
  onLoopEnd?: (launches: Launch[]) => void;
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
  let busy = false;
  let running: Promise<unknown> | null = null;

  const programId = PUMP_PROGRAM_ID.toBase58();

  const subscription = connection.onLogs(
    devWallet,
    async ({ signature, err, logs }) => {
      if (err || abort.signal.aborted || handled.has(signature)) return;
      handled.add(signature);
      if (!logs.some((l) => l.includes(programId)) || !logs.some((l) => CREATE_LOG.test(l))) return;

      try {
        const tx = await getParsedTx(connection, signature);
        const created = tx && createCallIn(tx);
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
          },
          { index: 0, mint: created.mint, signature, at: Date.now() },
        )
          .then((launches) => options.onLoopEnd?.(launches))
          .catch((e: Error) => log.error(`relaunch loop failed: ${e.message}`))
          .finally(() => {
            busy = false;
            running = null;
            if (!abort.signal.aborted) log.info("back to watching");
          });
      } catch (e) {
        log.error(`handling ${signature} failed: ${(e as Error).message}`);
      }
    },
    "confirmed",
  );

  log.info(`watching ${short(devWallet)} for pump.fun launches; relaunches go out from ${short(wallet.publicKey)}`);

  return {
    devWallet,
    async stop() {
      abort.abort();
      await connection.removeOnLogsListener(subscription).catch(() => undefined);
      await running?.catch(() => undefined);
      log.info(`stopped watching ${short(devWallet)}`);
    },
  };
}
