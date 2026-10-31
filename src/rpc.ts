import { Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { rpcUrls } from "./config.js";
import { sleep } from "./log.js";

export function makeConnection(): Connection {
  const { http, ws } = rpcUrls();
  return new Connection(http, { commitment: "confirmed", wsEndpoint: ws });
}

/** Newest transaction version the parsed-transaction calls accept. */
export const MAX_TX_VERSION = 1;

export async function getParsedTx(
  connection: Connection,
  signature: string,
  attempts = 5,
): Promise<ParsedTransactionWithMeta | null> {
  for (let i = 0; i < attempts; i++) {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: MAX_TX_VERSION,
      commitment: "confirmed",
    });
    if (tx) return tx;
    // A just-confirmed transaction can lag behind the websocket notification.
    await sleep(1000 * (i + 1));
  }
  return null;
}

export async function getParsedTxs(
  connection: Connection,
  signatures: string[],
): Promise<(ParsedTransactionWithMeta | null)[]> {
  if (signatures.length === 0) return [];
  return connection.getParsedTransactions(signatures, {
    maxSupportedTransactionVersion: MAX_TX_VERSION,
    commitment: "confirmed",
  });
}
