import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Loads the launching wallet from WALLET_PRIVATE_KEY, which may be a base58
 * secret key (Phantom export), a JSON byte array (solana-keygen output), or a
 * path to a solana-keygen JSON file.
 */
export function loadWallet(raw = process.env.WALLET_PRIVATE_KEY): Keypair {
  const value = raw?.trim();
  if (!value) {
    throw new Error("WALLET_PRIVATE_KEY is not set (base58 string, JSON byte array, or keypair file path)");
  }

  let bytes: Uint8Array;
  if (value.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(value) as number[]);
  } else if (existsSync(value)) {
    bytes = Uint8Array.from(JSON.parse(readFileSync(value, "utf8")) as number[]);
  } else {
    bytes = bs58.decode(value);
  }

  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  throw new Error(`WALLET_PRIVATE_KEY decoded to ${bytes.length} bytes, expected 32 or 64`);
}
