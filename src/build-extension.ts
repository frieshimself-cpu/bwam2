// Copies the shared dashboard assets into extension/ so the popup and the website stay identical.
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const shared = ["app.js", "style.css"];

async function main() {
  for (const file of shared) {
    await copyFile(resolve(root, "web", file), resolve(root, "extension", file));
    console.log(`extension/${file} ← web/${file}`);
  }
  console.log("load extension/ as an unpacked extension at chrome://extensions");
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
