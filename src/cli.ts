import { parseArgs } from "node:util";
import { PublicKey } from "@solana/web3.js";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { DEFAULT_JITO_URL, mergeSettings, settingsFromEnv, type RelaunchSettings } from "./config.js";
import { log, short } from "./log.js";
import { paramsFromMint, readTokenConfig, resolveLaunchParams } from "./metadata.js";
import { curveStats, describeParams, pumpUrl, tradeEventsIn } from "./pump.js";
import { relaunchUntilBought } from "./relaunch.js";
import { getParsedTxs, makeConnection } from "./rpc.js";
import { startServer } from "./server.js";
import { loadWallet } from "./wallet.js";
import { watchWallet } from "./watch.js";

const USAGE = `pump-relauncher

  npm run serve                      dashboard + API for the website and the extension popup
  npm run watch    -- [dev wallet]   copy every pump.fun launch this wallet makes (default: your launch wallet)
  npm run relaunch -- <mint>         relaunch an existing coin with its exact parameters
  npm run launch   -- <token.json>   upload metadata (or reuse "uri") and launch from a config file
  npm run status   -- <mint>         show a coin's parameters, curve and recent buys

options (override .env):
  --max <n>            relaunches after the first launch        (RELAUNCH_MAX)
  --interval <sec>     window each launch gets to attract buys  (RELAUNCH_INTERVAL_SEC)
  --poll <sec>         seconds between checks                   (RELAUNCH_POLL_SEC)
  --stop-on-buys <n>   outside buys that end the loop, 0=never  (RELAUNCH_STOP_ON_BUYS)
  --dev-buy <sol>      SOL to buy in the create transaction     (DEV_BUY_SOL)
  --priority-fee <µl>  micro-lamports per compute unit          (PRIORITY_FEE_MICROLAMPORTS)
  --jito               send through Jito with a tip             (JITO_URL)
  --jito-tip <sol>     Jito tip in SOL                          (JITO_TIP_SOL)
  --dry-run            simulate the launch, send nothing        (DRY_RUN)
`;

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      max: { type: "string" },
      interval: { type: "string" },
      poll: { type: "string" },
      "stop-on-buys": { type: "string" },
      "dev-buy": { type: "string" },
      "priority-fee": { type: "string" },
      jito: { type: "boolean" },
      "jito-tip": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function applyOverrides(settings: RelaunchSettings, values: ReturnType<typeof parse>["values"]): RelaunchSettings {
  return mergeSettings(settings, {
    maxRelaunches: values.max,
    intervalSec: values.interval,
    pollSec: values.poll,
    stopOnBuys: values["stop-on-buys"],
    devBuySol: values["dev-buy"],
    priorityFeeMicroLamports: values["priority-fee"],
    jitoUrl: values.jito ? settings.jitoUrl || DEFAULT_JITO_URL : undefined,
    jitoTipSol: values["jito-tip"],
    dryRun: values["dry-run"],
  });
}

function parsePubkey(raw: string | undefined, what: string): PublicKey {
  if (!raw) throw new Error(`missing ${what}\n\n${USAGE}`);
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid ${what}`);
  }
}

async function status(mint: PublicKey) {
  const connection = makeConnection();
  const [stats, params] = await Promise.all([curveStats(connection, mint), paramsFromMint(connection, mint)]);
  const me = process.env.WALLET_PRIVATE_KEY ? loadWallet().publicKey : null;

  log.info(pumpUrl(mint));
  log.info(`"${params.name}" ($${params.symbol}) ${describeParams(params)}`);
  log.info(`uri ${params.uri}`);
  log.info(`creator ${stats.creator.toBase58()}${me?.equals(stats.creator) ? " (you)" : ""}`);
  log.info(`SOL on curve ${stats.solRaised.toFixed(4)}, complete: ${stats.complete}`);

  const infos = await connection.getSignaturesForAddress(bondingCurvePda(mint), { limit: 100 }, "confirmed");
  const txs = await getParsedTxs(connection, infos.filter((i) => !i.err).map((i) => i.signature));
  let buys = 0;
  let outsideBuys = 0;
  let sells = 0;
  const buyers = new Set<string>();
  for (const tx of txs) {
    if (!tx) continue;
    for (const ev of tradeEventsIn(tx)) {
      if (!ev.mint.equals(mint)) continue;
      if (!ev.isBuy) {
        sells += 1;
        continue;
      }
      buys += 1;
      if (!me || !ev.user.equals(me)) {
        outsideBuys += 1;
        buyers.add(ev.user.toBase58());
      }
    }
  }
  log.info(
    `last ${txs.length} txs: ${buys} buy(s) (${outsideBuys} from ${buyers.size} wallet(s) other than ${me ? short(me) : "n/a"}), ${sells} sell(s)`,
  );
}

async function main() {
  const { values, positionals } = parse();
  const [command, arg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  const settings = applyOverrides(settingsFromEnv(), values);

  switch (command) {
    case "serve": {
      await startServer(settings);
      return new Promise<never>(() => {});
    }
    case "launch": {
      if (!arg) throw new Error(`missing token config path\n\n${USAGE}`);
      const connection = makeConnection();
      const wallet = loadWallet();
      const { config, dir } = await readTokenConfig(arg);
      const params = await resolveLaunchParams(config, dir);
      await relaunchUntilBought({ connection, wallet, params, settings: () => settings });
      return;
    }
    case "relaunch": {
      const mint = parsePubkey(arg, "mint address");
      const connection = makeConnection();
      const wallet = loadWallet();
      const params = await paramsFromMint(connection, mint);
      log.info(`source coin "${params.name}" ($${params.symbol}) ${describeParams(params)} uri ${params.uri}`);
      await relaunchUntilBought({ connection, wallet, params, settings: () => settings });
      return;
    }
    case "watch": {
      const connection = makeConnection();
      const wallet = loadWallet();
      const devWallet = arg ? parsePubkey(arg, "wallet address") : wallet.publicKey;
      const handle = watchWallet({ connection, wallet, devWallet, settings: () => settings });
      log.info("Ctrl+C to stop");
      process.once("SIGINT", () => {
        void handle.stop().then(() => process.exit(0));
      });
      return new Promise<never>(() => {});
    }
    case "status": {
      await status(parsePubkey(arg, "mint address"));
      return;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    log.error(err.message);
    process.exit(1);
  });
