// Copies the latest ABIs and deployed addresses into the app.
//   node sync.mjs                         -> the demo on Base Sepolia (84532)
//   EDITION=beta node sync.mjs            -> the beta on Base Sepolia (deployments/84532-beta.json)
//   CHAIN_ID=31337 [EDITION=beta] node sync.mjs -> a local test chain
//
// It also bakes the addresses and settings into the code (src/site-config.json), so the site still
// works if deployment.json or kairos-settings.json goes missing during an upload.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const chainId = process.env.CHAIN_ID || "84532";
const edition = process.env.EDITION === "beta" ? "beta" : "demo";
const file = edition === "beta" ? `${chainId}-beta.json` : `${chainId}.json`;
const dep = new URL(`../contracts/deployments/${file}`, import.meta.url);
copyFileSync(new URL("../shared/abis.json", import.meta.url), new URL("./src/abis.json", import.meta.url));
copyFileSync(new URL("../shared/bytecode.json", import.meta.url), new URL("./src/bytecode.json", import.meta.url));

let deployment = null;
if (existsSync(dep)) deployment = JSON.parse(readFileSync(dep, "utf8"));
else if (edition === "demo") {
  console.error(`No deployment for chain ${chainId} yet. Deploy the contracts first (see README).`);
  process.exit(1);
} else console.warn(`No beta deployment yet (contracts/deployments/${file}). The beta will show its setup screen.`);

writeFileSync(new URL("./public/deployment.json", import.meta.url), JSON.stringify(deployment || {}, null, 2) + "\n");
const settings = JSON.parse(readFileSync(new URL("./public/kairos-settings.json", import.meta.url), "utf8"));
writeFileSync(new URL("./src/site-config.json", import.meta.url), JSON.stringify({ edition, deployment, settings }, null, 2) + "\n");
console.log(`App (${edition}) now points at chain ${chainId}${deployment ? "" : " (not set up yet)"}.`);
