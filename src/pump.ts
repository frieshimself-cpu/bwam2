import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  MessageV1,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  V1_TRANSACTION_SIZE_LIMIT,
  VersionedTransaction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  pumpIdl,
  type PumpQuoteAccounts,
  type TradeEventBc,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import { chainCache } from "./cache.js";
import type { RelaunchSettings } from "./config.js";
import { describeFeeSharing, feeSharingInstructions, fetchFeeSharing, type FeeSharing } from "./fees.js";
import { getParsedTxs } from "./rpc.js";
import { log, short } from "./log.js";

/** Everything `create_v2` takes, i.e. everything a relaunch copies from the original coin. */
export interface LaunchParams {
  name: string;
  symbol: string;
  /** Metadata JSON URI: image, description and links. */
  uri: string;
  mayhemMode: boolean;
  cashback: boolean;
  /** The coin's own creator fee ("tax") in basis points; 0 = pump.fun's schedule rate. */
  creatorFeeBps: number;
  holderReward: boolean;
  /** The coin/stock the curve is quoted in; null = SOL. */
  quoteMint: string | null;
  /** The original creator wallet (receives the creator fee); null when it was a program account. */
  creator?: string | null;
  /** The coin these parameters were read from; its fee-sharing config is re-read at every launch. */
  sourceMint?: string | null;
  /** Fee split / donation setup to recreate; undefined = not looked up yet, null = none. */
  feeSharing?: FeeSharing | null;
}

export interface CreateCall extends LaunchParams {
  mint: PublicKey;
  user: PublicKey;
  v2: boolean;
}

export interface LaunchResult {
  mint: PublicKey;
  bondingCurve: PublicKey;
  signature: string;
}

/** Rough on-chain cost of one create (rent for mint + curve + mayhem accounts, plus fees). */
export const ESTIMATED_CREATE_COST_SOL = 0.03;

// Jito's published tip accounts; any one of them works.
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((k) => new PublicKey(k));

const randomTipAccount = () => JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

// Anchor's "emit_cpi" instruction discriminator: events arrive as inner
// instructions whose data is this prefix + event discriminator + borsh body.
const EVENT_IX_DISC = Buffer.from("e445a52e51cb9a1d", "hex");

function ixDiscriminator(name: string): Buffer {
  const ix = pumpIdl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`pump IDL has no instruction "${name}"`);
  return Buffer.from(ix.discriminator);
}

function eventDiscriminator(name: string): Buffer {
  const ev = pumpIdl.events.find((e) => e.name === name);
  if (!ev) throw new Error(`pump IDL has no event "${name}"`);
  return Buffer.from(ev.discriminator);
}

const CREATE_DISC = ixDiscriminator("create");
const CREATE_V2_DISC = ixDiscriminator("create_v2");
const TRADE_EVENT_DISC = eventDiscriminator("TradeEvent");
// create_v2's named accounts; anything after them is the quote selection (quote mint first).
const CREATE_V2_NAMED_ACCOUNTS = 16;

export const pumpUrl = (mint: PublicKey) => `https://pump.fun/coin/${mint.toBase58()}`;
export const txUrl = (signature: string) => `https://solscan.io/tx/${signature}`;

const isSolQuote = (mint: PublicKey) => mint.equals(PublicKey.default) || mint.equals(NATIVE_MINT);

/** One line describing the launch parameters, for logs and the dashboard. */
export function describeParams(p: LaunchParams): string {
  const parts = [p.quoteMint ? `paired with ${short(p.quoteMint)}` : "quoted in SOL"];
  if (p.creatorFeeBps > 0) parts.push(`creator fee ${(p.creatorFeeBps / 100).toFixed(2)}%`);
  if (p.cashback) parts.push("cashback");
  if (p.holderReward) parts.push("holder rewards");
  if (p.mayhemMode) parts.push("mayhem mode");
  if (p.feeSharing) parts.push(describeFeeSharing(p.feeSharing));
  else if (p.creator) parts.push(`fees → ${short(p.creator)}`);
  return parts.join(", ");
}

/** Every pump-program instruction in a parsed transaction, top-level and inner. */
export function pumpInstructions(tx: ParsedTransactionWithMeta): PartiallyDecodedInstruction[] {
  const out: PartiallyDecodedInstruction[] = [];
  const consider = (ix: unknown) => {
    const candidate = ix as PartiallyDecodedInstruction;
    if (candidate.programId?.equals(PUMP_PROGRAM_ID) && typeof candidate.data === "string") {
      out.push(candidate);
    }
  };
  tx.transaction.message.instructions.forEach(consider);
  for (const inner of tx.meta?.innerInstructions ?? []) inner.instructions.forEach(consider);
  return out;
}

/** Decodes a `create` / `create_v2` call out of a parsed transaction, if there is one. */
export function createCallIn(tx: ParsedTransactionWithMeta): CreateCall | null {
  for (const ix of pumpInstructions(tx)) {
    const data = Buffer.from(bs58.decode(ix.data));
    const disc = data.subarray(0, 8);
    const v2 = disc.equals(CREATE_V2_DISC);
    if (!v2 && !disc.equals(CREATE_DISC)) continue;

    let offset = 8;
    const readString = () => {
      const len = data.readUInt32LE(offset);
      offset += 4;
      const value = data.subarray(offset, offset + len).toString("utf8");
      offset += len;
      return value;
    };
    const name = readString();
    const symbol = readString();
    const uri = readString();
    const creatorKey = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;

    // create_v2 trailing args: is_mayhem_mode, then OptionBool / OptionU64 /
    // OptionBool, each only present when the sender's program version knew it.
    let mayhemMode = false;
    let cashback = false;
    let creatorFeeBps = 0;
    let holderReward = false;
    if (v2) {
      mayhemMode = data[offset] === 1;
      offset += 1;
      if (data.length >= offset + 1) {
        cashback = data[offset] === 1;
        offset += 1;
      }
      if (data.length >= offset + 8) {
        creatorFeeBps = Number(data.readBigUInt64LE(offset));
        offset += 8;
      }
      if (data.length >= offset + 1) holderReward = data[offset] === 1;
    }

    const quoteAccount = v2 && ix.accounts.length > CREATE_V2_NAMED_ACCOUNTS ? ix.accounts[CREATE_V2_NAMED_ACCOUNTS] : null;
    const quoteMint = quoteAccount && !isSolQuote(quoteAccount) ? quoteAccount.toBase58() : null;

    // Account order comes from the IDL: `user` is index 7 on create, 5 on create_v2.
    return {
      mint: ix.accounts[0],
      user: ix.accounts[v2 ? 5 : 7],
      v2,
      name,
      symbol,
      uri,
      mayhemMode,
      cashback,
      creatorFeeBps,
      holderReward,
      quoteMint,
      // a wallet is on the curve; program-owned creators (holder-reward / sharing PDAs) are not
      creator: PublicKey.isOnCurve(creatorKey.toBytes()) ? creatorKey.toBase58() : null,
      sourceMint: ix.accounts[0].toBase58(),
    };
  }
  return null;
}

const CREATE_EVENT_DISC = eventDiscriminator("CreateEvent");

/**
 * The create call decoded straight from a transaction's log messages (the
 * program logs its CreateEvent as `Program data: <base64>`), so a launch can
 * be acted on from the websocket notification alone, before the transaction
 * is even confirmed. Null when the logs carry no CreateEvent.
 */
export function createCallFromLogs(logs: string[]): CreateCall | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice("Program data: ".length), "base64");
    if (data.length < 8 || !data.subarray(0, 8).equals(CREATE_EVENT_DISC)) continue;
    try {
      const ev = PUMP_SDK.decodeCreateEventBc(data.subarray(8));
      return {
        mint: ev.mint,
        user: ev.user,
        v2: true,
        name: ev.name,
        symbol: ev.symbol,
        uri: ev.uri,
        mayhemMode: ev.isMayhemMode,
        cashback: ev.isCashbackEnabled,
        creatorFeeBps: ev.creatorFeeBps.toNumber(),
        holderReward: ev.isHolderReward,
        quoteMint: isSolQuote(ev.quoteMint) ? null : ev.quoteMint.toBase58(),
        creator: PublicKey.isOnCurve(ev.creator.toBytes()) ? ev.creator.toBase58() : null,
        sourceMint: ev.mint.toBase58(),
        // pump.fun's site sets a fee split up in the create transaction itself:
        // when that instruction is absent there is nothing to look up (yet)
        feeSharing: logs.some((l) => l.includes("Instruction: CreateFeeSharingConfig")) ? undefined : null,
      };
    } catch (err) {
      log.warn(`could not decode CreateEvent from logs: ${(err as Error).message}`);
    }
  }
  return null;
}

/** Every bonding-curve TradeEvent a parsed transaction emitted. */
export function tradeEventsIn(tx: ParsedTransactionWithMeta): TradeEventBc[] {
  const events: TradeEventBc[] = [];
  for (const ix of pumpInstructions(tx)) {
    const data = Buffer.from(bs58.decode(ix.data));
    if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_DISC)) continue;
    if (!data.subarray(8, 16).equals(TRADE_EVENT_DISC)) continue;
    try {
      events.push(PUMP_SDK.decodeTradeEventBc(data.subarray(16)));
    } catch (err) {
      log.warn(`could not decode TradeEvent: ${(err as Error).message}`);
    }
  }
  return events;
}

export interface ExternalBuy {
  signature: string;
  user: PublicKey;
  sol: number;
}

/**
 * Buys on `mint`'s bonding curve from wallets other than `exclude`, among the
 * transactions that landed after `since` and are not yet in `seen`.
 */
export async function fetchExternalBuys({
  connection,
  mint,
  since,
  exclude,
  seen,
}: {
  connection: Connection;
  mint: PublicKey;
  since: string;
  exclude: PublicKey;
  seen: Set<string>;
}): Promise<ExternalBuy[]> {
  const curve = bondingCurvePda(mint);
  const infos = await connection.getSignaturesForAddress(curve, { until: since || undefined, limit: 100 }, "confirmed");
  // `since` itself is excluded explicitly too: when the create is not yet
  // confirmed, `until` cannot stop at it and the dev's own first buy would count.
  const fresh = infos
    .filter((info) => !info.err && info.signature !== since && !seen.has(info.signature))
    .map((info) => info.signature);
  if (fresh.length === 0) return [];

  const buys: ExternalBuy[] = [];
  const txs = await getParsedTxs(connection, fresh);
  txs.forEach((tx, i) => {
    if (!tx) return; // not available yet; retry on the next poll
    seen.add(fresh[i]);
    for (const ev of tradeEventsIn(tx)) {
      // zero-lamport "buys" show up on-chain (token-account setup); they are not attention
      if (!ev.isBuy || ev.solAmount.isZero() || !ev.mint.equals(mint) || ev.user.equals(exclude)) continue;
      buys.push({ signature: fresh[i], user: ev.user, sol: ev.solAmount.toNumber() / LAMPORTS_PER_SOL });
    }
  });
  return buys;
}

export interface CurveStats {
  solRaised: number;
  complete: boolean;
  creator: PublicKey;
}

export async function curveStats(connection: Connection, mint: PublicKey): Promise<CurveStats> {
  const curve = await new OnlinePumpSdk(connection).fetchBondingCurve(mint);
  return {
    solRaised: curve.realQuoteReserves.toNumber() / LAMPORTS_PER_SOL,
    complete: curve.complete,
    creator: curve.creator,
  };
}

async function assertBalance(connection: Connection, wallet: PublicKey, settings: RelaunchSettings) {
  const balance = await chainCache(connection).getBalanceSol(wallet);
  const tip = settings.jitoUrl ? settings.jitoTipSol : 0;
  const needed = ESTIMATED_CREATE_COST_SOL + settings.devBuySol * 1.05 + tip;
  log.info(`wallet ${short(wallet)} balance ${balance.toFixed(4)} SOL (need ≈${needed.toFixed(4)} per launch)`);
  if (balance < needed) {
    throw new Error(`insufficient balance: ${balance.toFixed(4)} SOL, need about ${needed.toFixed(4)} SOL for one launch`);
  }
}

export interface PreparedLaunch {
  mintKeypair: Keypair;
  instructions: TransactionInstruction[];
  computeUnitLimit: number;
}

type LaunchSettings = Pick<RelaunchSettings, "devBuySol" | "priorityFeeMicroLamports" | "jitoUrl" | "jitoTipSol">;

/**
 * Builds the create_v2 (+ optional first buy, + optional Jito tip) instructions
 * for a fresh mint, replaying `params` exactly, paid and signed by `payer`.
 */
export async function prepareLaunch({
  connection,
  payer,
  params,
  settings,
}: {
  connection: Connection;
  payer: PublicKey;
  params: LaunchParams;
  settings: LaunchSettings;
}): Promise<PreparedLaunch> {
  const online = new OnlinePumpSdk(connection);
  const cache = chainCache(connection);
  const global = await cache.getGlobal();
  if (!global.createV2Enabled) throw new Error("pump.fun has create_v2 disabled right now; try again later");

  // Flags the program has since switched off are dropped rather than failing the launch.
  const cashback = params.cashback && global.isCashbackEnabled;
  if (params.cashback && !cashback) log.warn("original coin had cashback, which pump.fun no longer allows on new coins — launching without it");
  const holderReward = params.holderReward && global.isHolderRewardEnabled;
  if (params.holderReward && !holderReward) log.warn("holder-reward coins are disabled right now — launching without it");
  let creatorFeeBps: BN | undefined;
  if (params.creatorFeeBps > 0) {
    const max = global.maxConfigurableCreatorFeeBps.toNumber();
    if (!global.creatorFeeConfigurable) log.warn("per-coin creator fees are disabled right now — launching at the schedule rate");
    else creatorFeeBps = new BN(Math.min(params.creatorFeeBps, max || params.creatorFeeBps));
  }

  let quote: { quoteMint: PublicKey; quoteTokenProgram: PublicKey; pumpQuote?: PumpQuoteAccounts } | undefined;
  if (params.quoteMint) {
    const resolved = await online.resolveQuoteMint(new PublicKey(params.quoteMint));
    quote = {
      quoteMint: resolved.mint,
      quoteTokenProgram: resolved.quoteTokenProgram,
      pumpQuote: "pumpQuote" in resolved ? resolved.pumpQuote?.accounts : undefined,
    };
  }

  // A fee split needs the creator to sign its setup, so the launch wallet is
  // the creator then and the split sends fees on; otherwise the original
  // creator wallet receives the fee exactly as before.
  const sharing = params.feeSharing && !holderReward ? params.feeSharing : null;
  if (params.feeSharing && holderReward) log.warn("holder-reward coin also had a fee split; keeping holder rewards");
  const creator = sharing ? payer : params.creator ? new PublicKey(params.creator) : payer;

  const mintKeypair = Keypair.generate();
  const common = {
    mint: mintKeypair.publicKey,
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
    creator,
    user: payer,
    mayhemMode: params.mayhemMode,
    cashback,
    creatorFeeBps,
    holderReward,
  };

  const instructions: TransactionInstruction[] = [];
  const devBuyLamports = new BN(Math.round(settings.devBuySol * LAMPORTS_PER_SOL));
  let computeUnitLimit = 250_000;

  if (devBuyLamports.isZero() || quote) {
    if (!devBuyLamports.isZero()) log.warn("dev buy is only applied to SOL-quoted launches — creating without one");
    instructions.push(await PUMP_SDK.createV2Instruction({ ...common, ...quote }));
    if (quote) computeUnitLimit = 400_000;
  } else {
    const feeConfig = await cache.getFeeConfig();
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null, // quoted against a brand-new SOL curve
      amount: devBuyLamports,
      quoteMint: PublicKey.default,
      creatorFeeBps,
    });
    instructions.push(...(await PUMP_SDK.createV2AndBuyInstructions({ ...common, global, amount, solAmount: devBuyLamports })));
    computeUnitLimit = 400_000;
  }

  if (sharing) {
    instructions.push(
      ...(await feeSharingInstructions({
        creator: payer,
        mint: mintKeypair.publicKey,
        quoteMint: quote?.quoteMint,
        quoteTokenProgram: quote?.quoteTokenProgram,
        sharing,
      })),
    );
    computeUnitLimit = 600_000;
  }

  const tipLamports = Math.round(settings.jitoTipSol * LAMPORTS_PER_SOL);
  if (settings.jitoUrl && tipLamports > 0) {
    instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: randomTipAccount(), lamports: tipLamports }));
  }

  return { mintKeypair, instructions, computeUnitLimit };
}

// Version-1 message wire format (web3.js 1.x can parse it but not write it):
// prefix, header, config mask, blockhash, counts, static keys, config values,
// instruction headers, instruction payloads.
const V1_PREFIX = 0x81;
const MASK_PRIORITY_FEE = 0b00011;
const MASK_COMPUTE_UNIT_LIMIT = 0b00100;
const MASK_LOADED_ACCOUNTS_DATA_SIZE = 0b01000;
const MASK_HEAP_SIZE = 0b10000;

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

export function serializeMessageV1(m: MessageV1): Uint8Array {
  const cfg = m.transactionConfig;
  let mask = 0;
  const configValues: Buffer[] = [];
  if (cfg.priorityFee !== null) {
    mask |= MASK_PRIORITY_FEE;
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(cfg.priorityFee));
    configValues.push(b);
  }
  if (cfg.computeUnitLimit !== null) {
    mask |= MASK_COMPUTE_UNIT_LIMIT;
    configValues.push(u32(cfg.computeUnitLimit));
  }
  if (cfg.loadedAccountsDataSizeLimit !== null) {
    mask |= MASK_LOADED_ACCOUNTS_DATA_SIZE;
    configValues.push(u32(cfg.loadedAccountsDataSizeLimit));
  }
  if (cfg.heapSize !== null) {
    mask |= MASK_HEAP_SIZE;
    configValues.push(u32(cfg.heapSize));
  }

  if (m.staticAccountKeys.length > 255 || m.compiledInstructions.length > 255) throw new Error("too many accounts or instructions");
  const headers = m.compiledInstructions.map((ix) => {
    if (ix.accountKeyIndexes.length > 255 || ix.data.length > 65535) throw new Error("instruction too large");
    return Buffer.from([ix.programIdIndex, ix.accountKeyIndexes.length, ix.data.length & 0xff, ix.data.length >> 8]);
  });
  const payloads = m.compiledInstructions.map((ix) => Buffer.concat([Buffer.from(ix.accountKeyIndexes), Buffer.from(ix.data)]));

  return Buffer.concat([
    Buffer.from([V1_PREFIX, m.header.numRequiredSignatures, m.header.numReadonlySignedAccounts, m.header.numReadonlyUnsignedAccounts]),
    u32(mask),
    Buffer.from(bs58.decode(m.recentBlockhash)),
    Buffer.from([m.compiledInstructions.length, m.staticAccountKeys.length]),
    ...m.staticAccountKeys.map((key) => key.toBuffer()),
    ...configValues,
    ...headers,
    ...payloads,
  ]);
}

class SerializableMessageV1 extends MessageV1 {
  serialize(): Uint8Array {
    return serializeMessageV1(this);
  }
}

/**
 * A version-1 transaction is the message followed by its signatures (no
 * signature count), unlike legacy / v0, which web3.js 1.x would otherwise
 * write. Signing is unchanged: signatures are over the message bytes.
 */
export class V1Transaction extends VersionedTransaction {
  serialize(): Uint8Array {
    return Buffer.concat([Buffer.from(this.message.serialize()), ...this.signatures.map((s) => Buffer.from(s))]);
  }
}

/**
 * A version-1 transaction, like pump.fun's own site sends: the compute budget
 * rides in the message header and the size limit is 4096 bytes, so create +
 * first buy + tip fit without a lookup table.
 */
export function buildLaunchTransaction({
  payer,
  instructions,
  blockhash,
  computeUnitLimit,
  priorityFeeMicroLamports,
}: {
  payer: PublicKey;
  instructions: TransactionInstruction[];
  blockhash: string;
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
}): VersionedTransaction {
  const compiled = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const message = new SerializableMessageV1({
    header: compiled.header,
    staticAccountKeys: compiled.staticAccountKeys,
    recentBlockhash: blockhash,
    compiledInstructions: compiled.compiledInstructions,
    transactionConfig: {
      computeUnitLimit,
      heapSize: null,
      // the v1 default is too small for pump.fun's accounts; the site sets the 64 MiB maximum
      loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
      priorityFee: Math.ceil((priorityFeeMicroLamports * computeUnitLimit) / 1_000_000),
    },
  });
  return new V1Transaction(message);
}

async function simulateOrThrow(connection: Connection, tx: VersionedTransaction, what: string): Promise<number | undefined> {
  const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) {
    log.error(`${what}: simulation failed`, JSON.stringify(sim.value.err));
    for (const line of (sim.value.logs ?? []).filter((l) => /failed|error/i.test(l)).slice(-5)) log.error("  " + line);
    throw new Error(`${what}: simulation failed`);
  }
  return sim.value.unitsConsumed;
}

/** No preflight: the transaction shape is validated ahead of time, and the RPC's simulation would cost a round trip. */
async function sendViaRpc(connection: Connection, tx: VersionedTransaction): Promise<string> {
  try {
    return await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  } catch (err) {
    if (err instanceof SendTransactionError) {
      const logs = await err.getLogs(connection).catch(() => [] as string[]);
      for (const line of logs.filter((l) => /failed|error/i.test(l)).slice(-5)) log.error("  " + line);
    }
    throw err;
  }
}

/** The program's own error lines for a transaction that failed on-chain. */
async function failureLines(connection: Connection, signature: string): Promise<string[]> {
  const tx = await connection
    .getParsedTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" })
    .catch(() => null);
  return (tx?.meta?.logMessages ?? []).filter((l) => /failed|error/i.test(l)).slice(-5);
}

/** Jito runs no preflight, so only a clean simulation goes out. */
async function sendViaJito(connection: Connection, tx: VersionedTransaction, jitoUrl: string): Promise<string> {
  await simulateOrThrow(connection, tx, "jito send");
  const res = await fetch(`${jitoUrl.replace(/\/$/, "")}/api/v1/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64" }],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`jito send failed: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body.result;
}

/**
 * Creates a fresh coin with exactly `params` and optionally buys into it in
 * the same transaction. Resolves once the transaction is confirmed; in
 * dry-run mode it simulates instead and returns null.
 */
export async function launchCoin({
  connection,
  wallet,
  params,
  settings,
  onMint,
}: {
  connection: Connection;
  wallet: Keypair;
  params: LaunchParams;
  settings: RelaunchSettings;
  /** Called with the new mint before the transaction is sent. */
  onMint?: (mint: PublicKey) => void;
}): Promise<LaunchResult | null> {
  await assertBalance(connection, wallet.publicKey, settings);

  // The original's fee split may be set up after its create; look it up unless
  // the caller already knows there is none (the relaunch loop asks again later).
  if (params.sourceMint && params.feeSharing === undefined) {
    params = { ...params, feeSharing: await fetchFeeSharing(connection, new PublicKey(params.sourceMint)) };
  }

  const cache = chainCache(connection);
  const [{ mintKeypair, instructions, computeUnitLimit }, { blockhash, lastValidBlockHeight }] = await Promise.all([
    prepareLaunch({ connection, payer: wallet.publicKey, params, settings }),
    cache.getBlockhash(),
  ]);
  const mint = mintKeypair.publicKey;
  onMint?.(mint);
  const tx = buildLaunchTransaction({
    payer: wallet.publicKey,
    instructions,
    blockhash,
    computeUnitLimit,
    priorityFeeMicroLamports: settings.priorityFeeMicroLamports,
  });
  tx.sign([wallet, mintKeypair]);

  const size = tx.serialize().length;
  if (size > V1_TRANSACTION_SIZE_LIMIT) {
    throw new Error(`launch transaction is ${size} bytes (max ${V1_TRANSACTION_SIZE_LIMIT})`);
  }

  log.info(`launching "${params.name}" ($${params.symbol}) ${describeParams(params)} as mint ${mint.toBase58()} (${size} bytes)`);

  if (settings.dryRun) {
    const units = await simulateOrThrow(connection, tx, "dry run");
    log.info(`dry run: simulation ok, ${units ?? "?"} compute units — nothing was sent`);
    return null;
  }

  const signature = settings.jitoUrl
    ? await sendViaJito(connection, tx, settings.jitoUrl)
    : await sendViaRpc(connection, tx);
  log.info(`sent${settings.jitoUrl ? " via jito" : ""} ${txUrl(signature)}`);
  cache.invalidateBalance(wallet.publicKey);

  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) {
    for (const line of await failureLines(connection, signature)) log.error("  " + line);
    throw new Error(`launch transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  log.info(`live: ${pumpUrl(mint)}`);
  return { mint, bondingCurve: bondingCurvePda(mint), signature };
}
