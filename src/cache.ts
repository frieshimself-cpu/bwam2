// What a launch needs from the chain, kept warm in the background while
// watching, so a detected launch is copied with zero reads on the hot path.
import { Connection, LAMPORTS_PER_SOL, PublicKey, type BlockhashWithExpiryBlockHeight } from "@solana/web3.js";
import { OnlinePumpSdk, type FeeConfig, type Global } from "@pump-fun/pump-sdk";
import { log } from "./log.js";

const GLOBAL_TTL_MS = 60_000;
const BALANCE_TTL_MS = 20_000;
const BLOCKHASH_TTL_MS = 8_000; // a blockhash stays valid ~60 s; refreshed every 2 s while watching
const REFRESH_MS = 2_000;

interface Stamped<T> {
  value: T;
  at: number;
}

export class ChainCache {
  private readonly online: OnlinePumpSdk;
  private global?: Stamped<Global>;
  private feeConfig?: Stamped<FeeConfig | null>;
  private blockhash?: Stamped<BlockhashWithExpiryBlockHeight>;
  private readonly balances = new Map<string, Stamped<number>>();
  private timer: NodeJS.Timeout | null = null;
  private users = 0;
  private tick = 0;

  constructor(private readonly connection: Connection) {
    this.online = new OnlinePumpSdk(connection);
  }

  private fresh<T>(entry: Stamped<T> | undefined, ttl: number): entry is Stamped<T> {
    return !!entry && Date.now() - entry.at < ttl;
  }

  async getGlobal(): Promise<Global> {
    if (!this.fresh(this.global, GLOBAL_TTL_MS)) this.global = { value: await this.online.fetchGlobal(), at: Date.now() };
    return this.global.value;
  }

  async getFeeConfig(): Promise<FeeConfig | null> {
    if (!this.fresh(this.feeConfig, GLOBAL_TTL_MS)) {
      this.feeConfig = { value: await this.online.fetchFeeConfig().catch(() => null), at: Date.now() };
    }
    return this.feeConfig.value;
  }

  async getBlockhash(): Promise<BlockhashWithExpiryBlockHeight> {
    if (!this.fresh(this.blockhash, BLOCKHASH_TTL_MS)) {
      this.blockhash = { value: await this.connection.getLatestBlockhash("confirmed"), at: Date.now() };
    }
    return this.blockhash.value;
  }

  async getBalanceSol(wallet: PublicKey): Promise<number> {
    const key = wallet.toBase58();
    const entry = this.balances.get(key);
    if (this.fresh(entry, BALANCE_TTL_MS)) return entry.value;
    const sol = (await this.connection.getBalance(wallet, "confirmed")) / LAMPORTS_PER_SOL;
    this.balances.set(key, { value: sol, at: Date.now() });
    return sol;
  }

  invalidateBalance(wallet: PublicKey) {
    this.balances.delete(wallet.toBase58());
  }

  /** Keeps the blockhash, program state and the wallet's balance warm. Reference-counted. */
  startRefreshing(wallet: PublicKey) {
    this.users += 1;
    if (this.timer) return;
    const refresh = async () => {
      this.tick += 1;
      try {
        this.blockhash = { value: await this.connection.getLatestBlockhash("confirmed"), at: Date.now() };
        if (this.tick % 15 === 1) {
          await Promise.all([this.getGlobal(), this.getFeeConfig()]);
          this.balances.delete(wallet.toBase58());
          await this.getBalanceSol(wallet);
        }
      } catch (err) {
        log.warn(`cache refresh failed: ${(err as Error).message}`);
      }
    };
    void refresh();
    this.timer = setInterval(() => void refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stopRefreshing() {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

const caches = new WeakMap<Connection, ChainCache>();

export function chainCache(connection: Connection): ChainCache {
  let cache = caches.get(connection);
  if (!cache) {
    cache = new ChainCache(connection);
    caches.set(connection, cache);
  }
  return cache;
}
