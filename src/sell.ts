// Sells every pump.fun coin the launch wallet holds (the dev buys of its own
// copies) back to SOL on the bonding curve, and closes the emptied token
// accounts to recover their rent.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createCloseAccountInstruction } from "@solana/spl-token";
import { OnlinePumpSdk, PUMP_SDK, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { chainCache } from "./cache.js";
import type { RelaunchSettings } from "./config.js";
import { log, short } from "./log.js";
import { buildLaunchTransaction, pumpUrl, sendAndConfirm, simulateOrThrow } from "./pump.js";

export interface Holding {
  mint: PublicKey;
  tokenAccount: PublicKey;
  amount: BN;
  uiAmount: number;
  tokenProgram: PublicKey;
}

export interface SellResult {
  mint: string;
  url: string;
  tokens: number;
  solOut?: number;
  signature?: string;
  skipped?: string;
  error?: string;
}

/** Every non-empty token account the wallet owns, under both token programs. */
export async function findHoldings(connection: Connection, owner: PublicKey): Promise<Holding[]> {
  const holdings: Holding[] = [];
  for (const tokenProgram of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    const { value } = await connection.getParsedTokenAccountsByOwner(owner, { programId: tokenProgram }, "confirmed");
    for (const { pubkey, account } of value) {
      const info = account.data.parsed?.info;
      const amount = new BN(info?.tokenAmount?.amount ?? "0");
      if (amount.isZero()) continue;
      holdings.push({
        mint: new PublicKey(info.mint),
        tokenAccount: pubkey,
        amount,
        uiAmount: Number(info.tokenAmount.uiAmount ?? 0),
        tokenProgram,
      });
    }
  }
  return holdings;
}

/**
 * Sells all holdings on their bonding curves. Coins that graduated or are
 * quoted in a token are reported as skipped. With `dryRun` every sale is
 * simulated and nothing is sent.
 */
export async function sellAll({
  connection,
  wallet,
  settings,
  dryRun = settings.dryRun,
}: {
  connection: Connection;
  wallet: Keypair;
  settings: RelaunchSettings;
  dryRun?: boolean;
}): Promise<{ results: SellResult[]; balanceBefore: number; balanceAfter: number }> {
  const online = new OnlinePumpSdk(connection);
  const cache = chainCache(connection);
  const owner = wallet.publicKey;
  cache.invalidateBalance(owner);
  const balanceBefore = await cache.getBalanceSol(owner);
  const holdings = await findHoldings(connection, owner);
  log.info(`${holdings.length} token balance(s) in ${short(owner)}; ${balanceBefore.toFixed(4)} SOL${dryRun ? " [DRY RUN]" : ""}`);

  const results: SellResult[] = [];
  const [global, feeConfig] = await Promise.all([cache.getGlobal(), cache.getFeeConfig()]);

  for (const h of holdings) {
    const result: SellResult = { mint: h.mint.toBase58(), url: pumpUrl(h.mint), tokens: h.uiAmount };
    results.push(result);
    try {
      const state = await online.fetchSellState(h.mint, owner, h.tokenProgram).catch(() => null);
      if (!state) {
        result.skipped = "not a pump.fun coin";
        continue;
      }
      const curve = state.bondingCurve;
      if (curve.complete) {
        result.skipped = "graduated to PumpSwap; sell it there";
        continue;
      }
      if (!curve.quoteMint.equals(PublicKey.default)) {
        result.skipped = "quoted in a token, not SOL";
        continue;
      }
      const solAmount = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: curve.tokenTotalSupply,
        bondingCurve: curve,
        amount: h.amount,
      });
      result.solOut = solAmount.toNumber() / LAMPORTS_PER_SOL;

      const sell = await PUMP_SDK.sellInstructions({
        global,
        bondingCurveAccountInfo: state.bondingCurveAccountInfo,
        bondingCurve: curve,
        mint: h.mint,
        user: owner,
        amount: h.amount,
        solAmount,
        slippage: 20,
        tokenProgram: h.tokenProgram,
        mayhemMode: curve.isMayhemMode,
        cashback: curve.isCashbackCoin,
      });
      const close = createCloseAccountInstruction(h.tokenAccount, owner, owner, [], h.tokenProgram);

      const attempt = async (instructions: typeof sell) => {
        const { blockhash, lastValidBlockHeight } = await cache.getBlockhash();
        const tx = buildLaunchTransaction({
          payer: owner,
          instructions,
          blockhash,
          computeUnitLimit: 200_000,
          priorityFeeMicroLamports: settings.priorityFeeMicroLamports,
        });
        tx.sign([wallet]);
        if (dryRun) {
          await simulateOrThrow(connection, tx, `sell ${short(h.mint)}`);
          return "dry-run";
        }
        return sendAndConfirm(connection, tx, { blockhash, lastValidBlockHeight }, settings.jitoUrl);
      };

      log.info(`selling ${h.uiAmount} of ${short(h.mint)} for ≈${result.solOut.toFixed(4)} SOL`);
      try {
        result.signature = await attempt([...sell, close]);
      } catch (err) {
        log.warn(`sell + close failed (${(err as Error).message}); retrying without closing the token account`);
        result.signature = await attempt(sell);
      }
    } catch (err) {
      result.error = (err as Error).message;
      log.error(`could not sell ${short(h.mint)}: ${result.error}`);
    }
  }

  cache.invalidateBalance(owner);
  const balanceAfter = dryRun ? balanceBefore : await cache.getBalanceSol(owner);
  const sold = results.filter((r) => r.signature && r.signature !== "dry-run").length;
  log.info(
    `${dryRun ? "would sell" : "sold"} ${results.filter((r) => r.solOut !== undefined && !r.error).length}/${results.length}` +
      `${sold ? `, ${sold} sent` : ""}; balance ${balanceBefore.toFixed(4)} → ${balanceAfter.toFixed(4)} SOL`,
  );
  return { results, balanceBefore, balanceAfter };
}
