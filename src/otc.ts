// The OTC launcher (otcdesks.cash): a pump.fun coin whose creator fees are
// assigned, by fee-sharing config, to the protocol's reward wallet, which
// spends them on tokenised stock for the coin's holders. What makes a coin an
// OTC coin is on chain (the fee split); which stock(s) it pays is a listing on
// the protocol's API. A copy needs both, plus metadata whose website link
// points at the copy's own OTC page rather than the original's.
//
// Everything here follows https://otcdesks.cash/docs, "Launching from your own app".
import { PublicKey } from "@solana/web3.js";
import type { FeeSharing } from "./fees.js";
import { log, short, sleep } from "./log.js";

export const OTC_API = "https://otcdesks.cash";
/** "Launcher rewards": claims pump fees and buys the stock holders are owed. */
export const OTC_REWARD_WALLET = new PublicKey("2k5hrzuykwyTbUe8L7UriYAQhr5hijNLgBvEB4B9pP5y");

const OTC_COIN_PAGE = /otcdesks\.cash\/coin\//i;
const USER_AGENT = "pump-relauncher";

/** The fee split that makes a coin an OTC coin: everything to the reward wallet. */
export const OTC_FEE_SHARING: FeeSharing = { shareholders: [{ address: OTC_REWARD_WALLET.toBase58(), shareBps: 10000 }] };

export function isOtcSharing(sharing: FeeSharing | null | undefined): boolean {
  return !!sharing && sharing.shareholders.length === 1 && sharing.shareholders[0].address === OTC_REWARD_WALLET.toBase58() && sharing.shareholders[0].shareBps === 10000;
}

/** A coin's metadata JSON (what the URI points at), as far as a launch needs it. */
export interface CoinMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  [key: string]: unknown;
}

/** The coin's row on the OTC API: which stock(s) its holders are paid in. */
export interface OtcListing {
  mint: string;
  rewardMint?: string;
  rewardSymbol?: string;
  /** Several stocks = an "ETF" coin that rotates through them, in this order. */
  rewardBasket?: string[];
  pairMint?: string;
  pairSymbol?: string;
  category?: string;
}

export const otcCoinUrl = (mint: PublicKey | string) => `${OTC_API}/coin/${typeof mint === "string" ? mint : mint.toBase58()}`;

export function describeOtc(listing: OtcListing | null | undefined): string {
  if (!listing) return "OTC rewards";
  const basket = listing.rewardBasket?.length ? listing.rewardBasket : listing.rewardMint ? [listing.rewardMint] : [];
  const first = listing.rewardSymbol ?? (basket[0] ? short(basket[0]) : "?");
  return basket.length > 1 ? `OTC rewards: ${first} +${basket.length - 1}` : `OTC rewards: ${first}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
}

/** The metadata JSON behind `uri`, or null when it cannot be read within `timeoutMs`. */
export async function fetchMetadata(uri: string, timeoutMs = 2500): Promise<CoinMetadata | null> {
  try {
    const res = await fetchWithTimeout(uri, timeoutMs);
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    return json && typeof json === "object" ? (json as CoinMetadata) : null;
  } catch {
    return null;
  }
}

/** True when the metadata links to the coin's page on the OTC site, which its launcher writes. */
export function metadataLooksOtc(meta: CoinMetadata | null | undefined): boolean {
  if (!meta) return false;
  return [meta.website, meta.twitter, meta.telegram].some((v) => typeof v === "string" && OTC_COIN_PAGE.test(v));
}

/**
 * Pins a copy of `meta` whose website is the OTC page of `mint`, through the
 * OTC site's own pinning endpoint (the same one its launcher uses), and
 * returns the new metadata URI. Null on any failure, so the caller can fall
 * back to the original URI rather than not launch.
 */
export async function pinMetadataForOtc(meta: CoinMetadata, mint: PublicKey, timeoutMs = 2500): Promise<string | null> {
  const started = Date.now();
  try {
    if (!meta.image || typeof meta.image !== "string") return null;
    const image = await fetchWithTimeout(meta.image, timeoutMs);
    if (!image.ok) return null;
    const type = image.headers.get("content-type")?.split(";")[0] || "image/png";
    const ext = type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const blob = new Blob([await image.arrayBuffer()], { type });

    const form = new FormData();
    form.set("file", blob, `image.${ext}`);
    form.set("name", String(meta.name ?? ""));
    form.set("symbol", String(meta.symbol ?? ""));
    form.set("description", String(meta.description ?? ""));
    if (typeof meta.twitter === "string" && meta.twitter && !OTC_COIN_PAGE.test(meta.twitter)) form.set("twitter", meta.twitter);
    if (typeof meta.telegram === "string" && meta.telegram && !OTC_COIN_PAGE.test(meta.telegram)) form.set("telegram", meta.telegram);
    form.set("website", otcCoinUrl(mint));

    const remaining = timeoutMs - (Date.now() - started);
    if (remaining < 200) return null;
    const res = await fetchWithTimeout(`${OTC_API}/api/ipfs`, remaining, { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as { metadataUri?: string; uri?: string; error?: string };
    const uri = body.metadataUri ?? body.uri;
    if (!res.ok || typeof uri !== "string" || !/^https?:\/\//.test(uri)) {
      log.warn(`OTC metadata pin failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ""}); keeping the original metadata link`);
      return null;
    }
    return uri;
  } catch (err) {
    log.warn(`OTC metadata pin failed (${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}); keeping the original metadata link`);
    return null;
  }
}

/** The coin's OTC listing, or null when the site does not list it. */
export async function fetchOtcListing(mint: PublicKey, timeoutMs = 4000): Promise<OtcListing | null> {
  const res = await fetchWithTimeout(`${OTC_API}/api/coins?mint=${mint.toBase58()}`, timeoutMs);
  if (!res.ok) throw new Error(`OTC API answered HTTP ${res.status}`);
  const body = (await res.json()) as { coins?: OtcListing[] };
  const row = body.coins?.find((c) => c.mint === mint.toBase58());
  if (!row) return null;
  return {
    mint: row.mint,
    rewardMint: row.rewardMint,
    rewardSymbol: row.rewardSymbol,
    rewardBasket: Array.isArray(row.rewardBasket) ? row.rewardBasket.filter((m) => typeof m === "string") : undefined,
    pairMint: row.pairMint,
    pairSymbol: row.pairSymbol,
    category: row.category,
  };
}

/** Polls the OTC API until the coin is listed (its launcher lists it a moment after the create). */
export async function waitForOtcListing(mint: PublicKey, maxWaitMs: number, signal?: AbortSignal): Promise<OtcListing | null> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      const listing = await fetchOtcListing(mint);
      if (listing) return listing;
    } catch (err) {
      log.warn(`OTC listing lookup failed, retrying: ${(err as Error).message}`);
    }
    if (signal?.aborted || Date.now() >= deadline) return null;
    await sleep(2000, signal);
  }
}

let pairSymbols: Promise<Map<string, string>> | null = null;
/** mint → symbol for the quote assets the OTC site knows, cached for the process. */
async function otcPairSymbol(mint: string): Promise<string | undefined> {
  pairSymbols ??= (async () => {
    const res = await fetchWithTimeout(`${OTC_API}/api/pairs`, 5000);
    const body = (await res.json()) as { pairs?: { mint: string; symbol: string }[] };
    return new Map((body.pairs ?? []).map((p) => [p.mint, p.symbol]));
  })().catch(() => {
    pairSymbols = null;
    return new Map<string, string>();
  });
  return (await pairSymbols).get(mint);
}

export type OtcListResult = "listed" | "refused" | "failed";

/**
 * Lists a launched copy on the OTC site with the original's reward setup.
 * The site reads the chain first: a 400 means the copy's fee split does not
 * point at the reward wallet (final); a 409 means its node has not seen the
 * config yet (retried).
 */
export async function listOnOtc({
  mint,
  name,
  symbol,
  uri,
  creator,
  createTx,
  template,
  quoteMint,
  signal,
}: {
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  createTx: string;
  /** The original coin's listing: what the copy should pay its holders. */
  template: OtcListing;
  /** The copy's quote mint when it is not SOL. */
  quoteMint?: string | null;
  signal?: AbortSignal;
}): Promise<OtcListResult> {
  const body: Record<string, unknown> = {
    mint: mint.toBase58(),
    name,
    symbol,
    uri,
    creator: creator.toBase58(),
    createTx,
  };
  if (template.rewardMint) body.rewardMint = template.rewardMint;
  if (template.rewardSymbol) body.rewardSymbol = template.rewardSymbol;
  if (template.rewardBasket && template.rewardBasket.length > 1) body.rewardBasket = template.rewardBasket;
  const pairMint = quoteMint ?? template.pairMint;
  if (pairMint) {
    body.pairMint = pairMint;
    const pairSymbol = template.pairSymbol ?? (await otcPairSymbol(pairMint));
    if (pairSymbol) body.pairSymbol = pairSymbol;
  }

  for (let attempt = 1; attempt <= 15; attempt++) {
    if (signal?.aborted) return "failed";
    let status = 0;
    let text = "";
    try {
      const res = await fetchWithTimeout(`${OTC_API}/api/coins`, 8000, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      status = res.status;
      text = (await res.text().catch(() => "")).slice(0, 300);
    } catch (err) {
      log.warn(`OTC listing request failed (attempt ${attempt}): ${(err as Error).message}`);
    }
    if (status >= 200 && status < 300) return "listed";
    if (status === 400) {
      log.error(`OTC refused to list ${short(mint)}: ${text || "HTTP 400"}`);
      return "refused";
    }
    if (status === 409) log.info(`OTC has not seen the fee split of ${short(mint)} yet (attempt ${attempt}); retrying`);
    else if (status) log.warn(`OTC listing answered HTTP ${status} (attempt ${attempt}): ${text}`);
    await sleep(2000, signal);
  }
  return "failed";
}

/**
 * What one relaunch loop learns about its original coin, so later launches of
 * the same coin (and their follow-ups) need not look it up again.
 */
export class LaunchShared {
  /** The original's fee split once known; null = checked and there is none. */
  feeSharing?: FeeSharing | null;
  /** The original's OTC listing once known; null = the site does not list it. */
  otcListing?: OtcListing | null;
  private metadataPromise: Promise<CoinMetadata | null> | null = null;

  constructor(feeSharing?: FeeSharing | null) {
    if (feeSharing !== undefined) this.feeSharing = feeSharing;
  }

  /** The original's metadata JSON, fetched once (null when unreadable). */
  metadata(uri: string, timeoutMs?: number): Promise<CoinMetadata | null> {
    this.metadataPromise ??= fetchMetadata(uri, timeoutMs);
    return this.metadataPromise;
  }

  /** The launch is an OTC coin by any sign seen so far. */
  async isOtc(uri: string): Promise<boolean> {
    if (isOtcSharing(this.feeSharing) || this.otcListing) return true;
    return metadataLooksOtc(await this.metadata(uri));
  }
}
