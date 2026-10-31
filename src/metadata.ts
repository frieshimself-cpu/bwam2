import { readFile } from "node:fs/promises";
import { extname, basename, resolve, dirname } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { OnlinePumpSdk, bondingCurvePda } from "@pump-fun/pump-sdk";
import { fetchFeeSharing } from "./fees.js";
import { createCallIn, type LaunchParams } from "./pump.js";
import { getParsedTxs } from "./rpc.js";
import { log } from "./log.js";

export const PUMP_IPFS_ENDPOINT = "https://pump.fun/api/ipfs";

export interface TokenConfig {
  name: string;
  symbol: string;
  description?: string;
  /** Local path (relative to the config file) or http(s) URL of the coin image. */
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  /** Already-uploaded metadata JSON URI; when set, nothing is uploaded. */
  uri?: string;
  /** Launch parameters (all optional; defaults are a plain SOL-quoted coin). */
  mayhemMode?: boolean;
  creatorFeeBps?: number;
  holderReward?: boolean;
  quoteMint?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

export async function readTokenConfig(path: string): Promise<{ config: TokenConfig; dir: string }> {
  const absolute = resolve(path);
  const config = JSON.parse(await readFile(absolute, "utf8")) as TokenConfig;
  if (!config.name?.trim()) throw new Error(`${path}: "name" is required`);
  if (!config.symbol?.trim()) throw new Error(`${path}: "symbol" is required`);
  if (!config.uri?.trim() && !config.image?.trim()) {
    throw new Error(`${path}: set "image" (file or URL) to upload metadata, or "uri" to reuse existing metadata`);
  }
  if (config.quoteMint) new PublicKey(config.quoteMint); // validates
  return { config, dir: dirname(absolute) };
}

interface ImageFile {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  mime: string;
}

async function loadImage(source: string, dir: string): Promise<ImageFile> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`could not download image ${source}: HTTP ${res.status}`);
    const mime = res.headers.get("content-type")?.split(";")[0] || "image/png";
    const filename = basename(new URL(source).pathname) || "image";
    return { bytes: new Uint8Array(await res.arrayBuffer()), filename, mime };
  }
  const path = resolve(dir, source);
  const bytes = new Uint8Array(await readFile(path)); // copy out of the shared Buffer pool
  const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
  return { bytes, filename: basename(path), mime };
}

/** Uploads image + metadata JSON through pump.fun's IPFS endpoint and returns the metadata URI. */
export async function uploadToPumpIpfs(config: TokenConfig, dir: string): Promise<string> {
  const image = await loadImage(config.image!, dir);
  const form = new FormData();
  form.append("file", new Blob([image.bytes], { type: image.mime }), image.filename);
  form.append("name", config.name);
  form.append("symbol", config.symbol);
  form.append("description", config.description ?? "");
  if (config.twitter) form.append("twitter", config.twitter);
  if (config.telegram) form.append("telegram", config.telegram);
  if (config.website) form.append("website", config.website);
  form.append("showName", "true");

  const res = await fetch(PUMP_IPFS_ENDPOINT, { method: "POST", body: form });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(
      `pump.fun metadata upload failed: HTTP ${res.status} ${body}\n` +
        `If this keeps happening (Cloudflare blocks some networks), upload once through the pump.fun site ` +
        `and put that coin's metadata URI in the config as "uri" — or run "relaunch <mint>" with the coin you made there.`,
    );
  }
  const json = (await res.json()) as { metadataUri?: string };
  if (!json.metadataUri) throw new Error(`pump.fun metadata upload returned no metadataUri: ${JSON.stringify(json)}`);
  return json.metadataUri;
}

/** Launch parameters from a token config file, uploading the metadata when no `uri` is given. */
export async function resolveLaunchParams(config: TokenConfig, dir: string): Promise<LaunchParams> {
  let uri = config.uri?.trim();
  if (uri) {
    log.info(`using existing metadata uri ${uri}`);
  } else {
    log.info(`uploading "${config.image}" + metadata to pump.fun IPFS…`);
    uri = await uploadToPumpIpfs(config, dir);
    log.info(`metadata uri ${uri}`);
  }
  return {
    name: config.name.trim(),
    symbol: config.symbol.trim(),
    uri,
    mayhemMode: config.mayhemMode === true,
    cashback: false,
    creatorFeeBps: Math.max(0, Math.floor(config.creatorFeeBps ?? 0)),
    holderReward: config.holderReward === true,
    quoteMint: config.quoteMint?.trim() || null,
  };
}

/** Walks the bonding curve's history back to its first transaction and decodes the create call. */
async function createCallFromHistory(connection: Connection, mint: PublicKey): Promise<LaunchParams | null> {
  const curve = bondingCurvePda(mint);
  let before: string | undefined;
  let oldest: string | undefined;
  for (;;) {
    const page = await connection.getSignaturesForAddress(curve, { before, limit: 1000 }, "confirmed");
    if (page.length === 0) break;
    oldest = page[page.length - 1].signature;
    before = oldest;
    if (page.length < 1000) break;
  }
  if (!oldest) return null;
  const [tx] = await getParsedTxs(connection, [oldest]);
  return tx ? createCallIn(tx) : null;
}

/**
 * The exact launch parameters of an existing pump.fun coin: name, symbol and
 * metadata URI from the mint, quote pairing / creator fee / cashback /
 * holder-reward / mayhem flags from its bonding curve.
 */
export async function paramsFromMint(connection: Connection, mint: PublicKey): Promise<LaunchParams> {
  const curve = await new OnlinePumpSdk(connection).fetchBondingCurve(mint);
  const flags = {
    mayhemMode: curve.isMayhemMode,
    cashback: curve.isCashbackCoin,
    creatorFeeBps: curve.creatorFeeBps.toNumber(),
    holderReward: curve.isHolderReward,
    quoteMint: curve.quoteMint.equals(PublicKey.default) ? null : curve.quoteMint.toBase58(),
    creator: PublicKey.isOnCurve(curve.creator.toBytes()) ? curve.creator.toBase58() : null,
    sourceMint: mint.toBase58(),
    feeSharing: await fetchFeeSharing(connection, mint),
  };

  // create_v2 coins are Token-2022 mints carrying their metadata on the mint itself.
  try {
    const onMint = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (onMint?.uri) return { name: onMint.name, symbol: onMint.symbol, uri: onMint.uri, ...flags };
  } catch {
    // legacy SPL-token coin, or not a Token-2022 mint: fall through
  }
  const fromHistory = await createCallFromHistory(connection, mint);
  if (fromHistory) return { ...fromHistory, ...flags };
  throw new Error(`could not read metadata for ${mint.toBase58()} — is it a pump.fun coin?`);
}
