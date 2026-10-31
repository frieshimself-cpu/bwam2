// Creator-fee routing that lives outside the create instruction: pump.fun's
// fee-sharing config (split creator fees across up to 10 recipients, including
// donate.gg "donation" escrows and GitHub social recipients). A copy recreates
// the original coin's config on the new mint so fees flow to the same places.
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PUMP_SDK, creatorVaultPda, donationFeePda, feeSharingConfigPda } from "@pump-fun/pump-sdk";
import { coinCreatorVaultAuthorityPda } from "@pump-fun/pump-sdk/swap";
import { short } from "./log.js";

export interface FeeShare {
  /** Recipient: a wallet, a reusable social-fee PDA, or (with `donationConfigId`) a per-coin donation escrow. */
  address: string;
  shareBps: number;
  /** donate.gg config this share is escrowed for; the escrow PDA is per coin and is recreated on the copy. */
  donationConfigId?: string;
}

export interface FeeSharing {
  shareholders: FeeShare[];
}

/** The coin's fee-sharing config, or null when the creator never set one up. */
export async function fetchFeeSharing(connection: Connection, mint: PublicKey): Promise<FeeSharing | null> {
  const info = await connection.getAccountInfo(feeSharingConfigPda(mint), "confirmed");
  if (!info) return null;
  const config = PUMP_SDK.decodeSharingConfig(info);
  const accounts = await connection.getMultipleAccountsInfo(config.shareholders.map((s) => s.address));
  const shareholders = config.shareholders.map((s, i) => {
    const share: FeeShare = { address: s.address.toBase58(), shareBps: s.shareBps };
    const account = accounts[i];
    if (account && !PublicKey.isOnCurve(s.address.toBytes())) {
      try {
        share.donationConfigId = PUMP_SDK.decodeDonationFeePda(account).configId.toBase58();
      } catch {
        // not a donation escrow (e.g. a social-fee PDA): reusable as is
      }
    }
    return share;
  });
  return { shareholders };
}

export function describeFeeSharing(sharing: FeeSharing): string {
  const parts = sharing.shareholders.map((s) => {
    const pct = `${(s.shareBps / 100).toFixed(s.shareBps % 100 ? 2 : 0)}%`;
    return s.donationConfigId ? `${pct} donation` : `${pct} → ${short(s.address)}`;
  });
  return `fees ${parts.join(", ")}`;
}

/**
 * Instructions that recreate `sharing` on a freshly created coin whose
 * creator is `creator` (which signs): donation escrows for the new mint,
 * the sharing config, then the one-time share update.
 */
export async function feeSharingInstructions({
  creator,
  mint,
  quoteMint,
  quoteTokenProgram = TOKEN_PROGRAM_ID,
  sharing,
}: {
  creator: PublicKey;
  mint: PublicKey;
  /** The coin's quote mint; undefined / zero key / WSOL = SOL. */
  quoteMint?: PublicKey;
  quoteTokenProgram?: PublicKey;
  sharing: FeeSharing;
}): Promise<TransactionInstruction[]> {
  const instructions: TransactionInstruction[] = [];
  const newShareholders: { address: PublicKey; shareBps: number }[] = [];
  const solQuoted = !quoteMint || quoteMint.equals(PublicKey.default) || quoteMint.equals(NATIVE_MINT);

  for (const share of sharing.shareholders) {
    if (share.donationConfigId) {
      const configId = new PublicKey(share.donationConfigId);
      instructions.push(
        await PUMP_SDK.createDonationFeePda({ coinCreator: creator, mint, configId, quoteMint: solQuoted ? undefined : quoteMint }),
      );
      newShareholders.push({ address: donationFeePda(mint, configId), shareBps: share.shareBps });
    } else {
      newShareholders.push({ address: new PublicKey(share.address), shareBps: share.shareBps });
    }
  }

  instructions.push(await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null }));
  const update = {
    authority: creator,
    mint,
    currentShareholders: [creator],
    newShareholders,
    bondingCurveComplete: false,
  };
  const updateIx = solQuoted
    ? await PUMP_SDK.updateFeeShares(update)
    : await PUMP_SDK.updateFeeSharesV2({ ...update, quoteMint: quoteMint!, quoteTokenProgram });

  if (!solQuoted) {
    // On a token quote the share update pays pending fees out through quote
    // token accounts that nothing creates on its own: the creator's, and the
    // creator vault's (the sharing config is the coin's creator now). Create
    // whichever of them the instruction references, as pump.fun's site does.
    const sharingPda = feeSharingConfigPda(mint);
    const owners = [creator, creatorVaultPda(sharingPda), coinCreatorVaultAuthorityPda(sharingPda)];
    const referenced = new Set(updateIx.keys.map((k) => k.pubkey.toBase58()));
    for (const owner of owners) {
      const ata = getAssociatedTokenAddressSync(quoteMint!, owner, true, quoteTokenProgram);
      if (referenced.has(ata.toBase58())) {
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(creator, ata, owner, quoteMint!, quoteTokenProgram));
      }
    }
  }

  instructions.push(updateIx);
  return instructions;
}
