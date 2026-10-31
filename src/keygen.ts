// Generates the launch wallet: writes its secret key into .env as WALLET_PRIVATE_KEY
// and prints only the public address. Nobody has to handle a private key.
//   npm run keygen            (keeps an existing wallet, prints its address)
//   npm run keygen -- --force (replaces it — only if the old one holds nothing you want)
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadWallet } from "./wallet.js";

const envFile = resolve(process.env.ENV_FILE || ".env");
const force = process.argv.includes("--force");

let text = "";
if (existsSync(envFile)) text = readFileSync(envFile, "utf8");
else if (existsSync(resolve(".env.example"))) text = readFileSync(resolve(".env.example"), "utf8");

const current = text.match(/^WALLET_PRIVATE_KEY=(.*)$/m);
if (current?.[1].trim() && !force) {
  const existing = loadWallet(current[1].trim());
  console.log(`launch wallet: ${existing.publicKey.toBase58()}`);
  console.log(`already set in ${envFile}; run with --force to replace it (the old wallet's funds would be left behind)`);
  process.exit(0);
}

const wallet = Keypair.generate();
const line = `WALLET_PRIVATE_KEY=${bs58.encode(wallet.secretKey)}`;
if (current) text = text.replace(/^WALLET_PRIVATE_KEY=.*$/m, line);
else text += (text === "" || text.endsWith("\n") ? "" : "\n") + line + "\n";
writeFileSync(envFile, text);
try {
  chmodSync(envFile, 0o600);
} catch {
  // Windows: no POSIX modes
}

console.log(`launch wallet: ${wallet.publicKey.toBase58()}`);
console.log(`secret written to ${envFile} — never share that file. Send SOL to the address above to fund launches.`);
