// Copies contract ABIs and bytecode from contracts/out into shared/ (used by the app and the keeper).
// Run after `forge build`:  node shared/export-abis.mjs
import { readFileSync, writeFileSync } from "node:fs";
const names = ["MockUSDC", "MockTBill", "KairosVault", "DemoRandomSource", "ChainlinkVRFSource", "KairosBetaSetup"];
const out = {};
const bytecode = {};
for (const n of names) {
  const art = JSON.parse(readFileSync(new URL(`../contracts/out/${n}.sol/${n}.json`, import.meta.url)));
  out[n] = art.abi;
  bytecode[n] = art.bytecode.object;
}
writeFileSync(new URL("./abis.json", import.meta.url), JSON.stringify(out, null, 2));
writeFileSync(new URL("./bytecode.json", import.meta.url), JSON.stringify(bytecode));
console.log("Wrote shared/abis.json and shared/bytecode.json");
