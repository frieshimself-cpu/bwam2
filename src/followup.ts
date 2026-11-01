// What a copy needs after its create has landed: the original's creator-fee
// routing (a fee split, or OTC's reward wallet) applied to the new mint, and —
// for an OTC coin — the copy listed on the OTC site with the same reward
// stock(s). Both are separate transactions / requests by nature: pump.fun's
// site and the OTC launcher set the fee split up right after the create, so
// an instant copy cannot know it at create time, and the OTC site only lists
// a coin whose fee split it can already see on chain.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import { chainCache } from "./cache.js";
import type { RelaunchSettings } from "./config.js";
import { describeFeeSharing, feeSharingInstructions, fetchFeeSharing, type FeeSharing } from "./fees.js";
import { log, short, sleep } from "./log.js";
import { LaunchShared, OTC_FEE_SHARING, describeOtc, isOtcSharing, listOnOtc, waitForOtcListing } from "./otc.js";
import { buildLaunchTransaction, sendAndConfirm, simulateOrThrow, txUrl, type LaunchParams } from "./pump.js";
import type { Launch } from "./relaunch.js";

/** How long to keep checking the original for a fee split set up after its create. */
const FEE_SPLIT_WAIT_MS = 90_000;
/** How long to wait for the original to show up on the OTC site. */
const OTC_LISTING_WAIT_MS = 120_000;

export interface FollowUpOptions {
  connection: Connection;
  wallet: Keypair;
  /** The original coin's parameters (the copy was launched from these). */
  params: LaunchParams;
  /** The copy. */
  launch: Launch;
  shared: LaunchShared;
  settings: () => RelaunchSettings;
  signal?: AbortSignal;
  /** Called whenever `launch.notes` changes. */
  onUpdate?: (launch: Launch) => void;
}

/** Runs the follow-up for one launched copy; never throws (everything is logged). */
export async function followUpLaunch(options: FollowUpOptions): Promise<void> {
  const { launch, params, signal } = options;
  const tag = `$${params.symbol} copy #${launch.index}`;
  const note = (text: string) => {
    launch.notes.push(text);
    options.onUpdate?.(launch);
  };

  try {
    const sharing = await targetFeeSharing(options);
    if (signal?.aborted) return;
    if (!sharing) return;
    if (params.holderReward) {
      log.warn(`${tag}: the original has a fee split but is a holder-reward coin; keeping holder rewards`);
      return;
    }

    const otc = isOtcSharing(sharing);
    try {
      // Re-running the follow-up (the dashboard's retry) must not fail on a split that is already there.
      const existing = await fetchFeeSharing(options.connection, launch.mint).catch(() => null);
      if (existing) {
        log.info(`${tag}: ${short(launch.mint)} already has its fee split (${describeFeeSharing(existing)})`);
        if (!launch.notes.some((n) => n.startsWith("fees → ") || n.startsWith("fees "))) note(isOtcSharing(existing) ? "fees → OTC rewards" : describeFeeSharing(existing));
      } else {
        const signature = await applyFeeSharing(options, sharing);
        log.info(`${tag}: ${otc ? "fees → OTC rewards" : describeFeeSharing(sharing)} set on ${short(launch.mint)} — ${txUrl(signature)}`);
        note(otc ? "fees → OTC rewards" : describeFeeSharing(sharing));
      }
    } catch (err) {
      if (signal?.aborted) return;
      log.error(`${tag}: could not set the fee split on ${short(launch.mint)}: ${(err as Error).message}`);
      note(`fee split failed: ${(err as Error).message}`);
      return;
    }

    if (otc) await registerOnOtc(options, note);
  } catch (err) {
    if (!signal?.aborted) log.error(`${tag}: follow-up failed: ${(err as Error).message}`);
  }
}

/**
 * The fee split the copy should carry: the original's, once it exists. An
 * OTC launch is recognised from its metadata before the split is even on
 * chain; anything else is polled for a while, since pump.fun's site writes
 * the split in a second transaction right after the create.
 */
async function targetFeeSharing({ connection, params, launch, shared, signal }: FollowUpOptions): Promise<FeeSharing | null> {
  if (shared.feeSharing !== undefined) return shared.feeSharing;
  const tag = `$${params.symbol} copy #${launch.index}`;

  if (await shared.isOtc(params.uri)) {
    log.info(`${tag}: the original is an OTC launch; routing the copy's creator fees to OTC rewards`);
    shared.feeSharing = OTC_FEE_SHARING;
    return OTC_FEE_SHARING;
  }
  if (!params.sourceMint) return null;

  const source = new PublicKey(params.sourceMint);
  const deadline = Date.now() + FEE_SPLIT_WAIT_MS;
  for (;;) {
    try {
      const found = await fetchFeeSharing(connection, source);
      if (found) {
        log.info(`${tag}: the original has a fee split (${describeFeeSharing(found)}); copying it`);
        shared.feeSharing = found;
        return found;
      }
    } catch (err) {
      log.warn(`${tag}: fee split lookup failed, retrying: ${(err as Error).message}`);
    }
    if (signal?.aborted || Date.now() >= deadline) break;
    await sleep(1500, signal);
  }
  if (!signal?.aborted) shared.feeSharing = null; // checked long enough: there is none
  return null;
}

/** Sends the transaction that puts `sharing` on the copy, as its creator (the launch wallet). */
async function applyFeeSharing({ connection, wallet, params, launch, settings, signal }: FollowUpOptions, sharing: FeeSharing): Promise<string> {
  const creator = wallet.publicKey;
  let quoteMint = NATIVE_MINT;
  let quoteTokenProgram = TOKEN_PROGRAM_ID;
  let tokenQuote: PublicKey | undefined;
  if (params.quoteMint) {
    const resolved = await new OnlinePumpSdk(connection).resolveQuoteMint(new PublicKey(params.quoteMint));
    quoteMint = resolved.mint;
    quoteTokenProgram = resolved.quoteTokenProgram;
    tokenQuote = resolved.mint;
  }

  const instructions = [
    // Buys since the create may have left creator fees on the curve, which block a share update.
    await PUMP_SDK.sweepCreatorFeeInstruction({ payer: creator, mint: launch.mint, creator, quoteMint, quoteTokenProgram }),
    ...(await feeSharingInstructions({ creator, mint: launch.mint, quoteMint: tokenQuote, quoteTokenProgram, sharing })),
  ];
  // The create was confirmed a moment ago, but the RPC node that simulates
  // may still be a slot behind it and not know the mint yet: retry for a while.
  const deadline = Date.now() + 15_000;
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await chainCache(connection).getBlockhash();
    const tx = buildLaunchTransaction({
      payer: creator,
      instructions,
      blockhash,
      computeUnitLimit: 400_000,
      priorityFeeMicroLamports: settings().priorityFeeMicroLamports,
    });
    tx.sign([wallet]);
    try {
      await simulateOrThrow(connection, tx, "fee split");
    } catch (err) {
      if (signal?.aborted || Date.now() >= deadline) throw err;
      log.warn(`$${params.symbol} copy #${launch.index}: fee split simulation failed (attempt ${attempt}); the node may not have the coin yet, retrying`);
      await sleep(1000, signal);
      continue;
    }
    return sendAndConfirm(connection, tx, { blockhash, lastValidBlockHeight });
  }
}

/** Lists the copy on the OTC site with the original's reward setup. */
async function registerOnOtc({ wallet, params, launch, shared, signal }: FollowUpOptions, note: (text: string) => void): Promise<void> {
  const tag = `$${params.symbol} copy #${launch.index}`;
  if (!params.sourceMint) return;

  if (shared.otcListing === undefined) {
    log.info(`${tag}: looking up what the original pays its holders on the OTC site`);
    shared.otcListing = await waitForOtcListing(new PublicKey(params.sourceMint), OTC_LISTING_WAIT_MS, signal);
  }
  const template = shared.otcListing;
  if (!template) {
    if (!signal?.aborted) log.warn(`${tag}: the original is not listed on the OTC site, so the copy cannot be listed either`);
    return;
  }

  const result = await listOnOtc({
    mint: launch.mint,
    name: params.name,
    symbol: params.symbol,
    uri: launch.uri,
    creator: wallet.publicKey,
    createTx: launch.signature,
    template,
    quoteMint: params.quoteMint,
    signal,
  });
  if (result === "listed") {
    log.info(`${tag}: listed on the OTC site — ${describeOtc(template)}`);
    note(describeOtc(template));
  } else if (!signal?.aborted) {
    log.error(`${tag}: OTC listing ${result}; the copy pays OTC rewards but is not on the site's board`);
    note(`OTC listing ${result}`);
  }
}
