// Sends SOL out of the deploy wallet (for example back to Phantom before the
// server is handed to someone else, or before importing a different wallet).
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { log, short } from "./log.js";
import { txUrl } from "./pump.js";

/** Base fee of a one-signature transaction. */
const FEE_LAMPORTS = 5000;
/** A system account left with fewer lamports than this (but more than 0) is refused by the runtime. */
const RENT_EXEMPT_MIN_LAMPORTS = 890_880;

export interface WithdrawPlan {
  tx: VersionedTransaction;
  lamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
  balanceLamports: number;
}

/**
 * The transfer of `amountSol` (or everything, when undefined) from `from` to
 * `to`, unsigned. Throws with a plain message when the amount cannot be sent.
 */
export async function buildWithdraw(
  connection: Connection,
  from: PublicKey,
  to: PublicKey,
  amountSol?: number,
): Promise<WithdrawPlan> {
  if (to.equals(from)) throw new Error("that is the deploy wallet itself");
  const balanceLamports = await connection.getBalance(from, "confirmed");
  const available = balanceLamports - FEE_LAMPORTS;
  if (available <= 0) throw new Error("the deploy wallet is empty");

  const lamports = amountSol === undefined ? available : Math.round(amountSol * LAMPORTS_PER_SOL);
  if (!Number.isFinite(lamports) || lamports <= 0) throw new Error("amount must be more than 0");
  if (lamports > available) throw new Error(`only ${(available / LAMPORTS_PER_SOL).toFixed(6)} SOL can be sent`);
  const left = available - lamports;
  if (left > 0 && left < RENT_EXEMPT_MIN_LAMPORTS) {
    throw new Error(`that would leave ${(left / LAMPORTS_PER_SOL).toFixed(6)} SOL, below the 0.00089 SOL a wallet must keep; send everything or a little less`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })],
  }).compileToV0Message();
  return { tx: new VersionedTransaction(message), lamports, blockhash, lastValidBlockHeight, balanceLamports };
}

export interface WithdrawResult {
  to: string;
  sol: number;
  signature: string | null;
  simulated: boolean;
}

/** Sends (or, with `dryRun`, simulates) the withdrawal and waits for confirmation. */
export async function withdrawSol({
  connection,
  wallet,
  to,
  amountSol,
  dryRun,
}: {
  connection: Connection;
  wallet: Keypair;
  to: PublicKey;
  amountSol?: number;
  dryRun: boolean;
}): Promise<WithdrawResult> {
  const plan = await buildWithdraw(connection, wallet.publicKey, to, amountSol);
  plan.tx.sign([wallet]);
  const sol = plan.lamports / LAMPORTS_PER_SOL;

  if (dryRun) {
    const sim = await connection.simulateTransaction(plan.tx, { commitment: "confirmed" });
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
    log.info(`test mode: withdrawing ${sol.toFixed(6)} SOL to ${short(to)} simulated fine — nothing was sent`);
    return { to: to.toBase58(), sol, signature: null, simulated: true };
  }

  const signature = await connection.sendRawTransaction(plan.tx.serialize(), { maxRetries: 5 });
  log.info(`withdrawing ${sol.toFixed(6)} SOL to ${to.toBase58()} — ${txUrl(signature)}`);
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: plan.blockhash, lastValidBlockHeight: plan.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) throw new Error(`withdrawal failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  log.info(`withdrew ${sol.toFixed(6)} SOL to ${short(to)}`);
  return { to: to.toBase58(), sol, signature, simulated: false };
}
