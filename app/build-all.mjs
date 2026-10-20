// Builds both copies of the site:  dist/       the demo
//                                  dist/beta/  the beta (Chainlink draws, Apple Pay test mode, send/receive)
//   node build-all.mjs                 (Base Sepolia)
//   CHAIN_ID=31337 node build-all.mjs  (local test chain)
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });
run("node sync.mjs", { EDITION: "demo" });
run("npx vite build --logLevel warn", { VITE_EDITION: "demo" });
run("node sync.mjs", { EDITION: "beta" });
run("npx vite build --logLevel warn --outDir dist/beta --emptyOutDir", { VITE_EDITION: "beta" });
run("node sync.mjs", { EDITION: "demo" }); // leave the working copy pointing at the demo
console.log("Built dist/ (demo) and dist/beta/ (beta).");
