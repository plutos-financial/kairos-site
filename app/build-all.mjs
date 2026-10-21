// Builds the site that GitHub publishes:
//   dist/        Kairos (Chainlink VRF draws, Add money with Apple Pay in Coinbase test mode, wallet)
//   dist/beta/   redirects, so old /beta/ links still work
// The older demo edition (simple random source, free test dollars) can still be built with
//   node sync.mjs && vite build
//   CHAIN_ID=31337 node build-all.mjs   -> local test chain
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
const run = (cmd, env = {}) => execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
const dist = new URL("./dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });
run("node sync.mjs", { EDITION: "beta" });
run("npx vite build --logLevel warn", { VITE_EDITION: "beta" });

// /beta/<page>.html -> /<page>.html (keeps ?query and #hash)
mkdirSync(new URL("./beta/", dist), { recursive: true });
for (const f of readdirSync(dist).filter((f) => f.endsWith(".html"))) {
  const to = `../${f === "index.html" ? "" : f}`;
  writeFileSync(
    new URL(`./beta/${f}`, dist),
    `<!doctype html><meta charset="utf-8"><title>Kairos</title><meta http-equiv="refresh" content="0; url=${to}">` +
      `<script>location.replace(${JSON.stringify(to)} + location.search + location.hash)</script>` +
      `<p>Kairos has moved to <a href="${to}">the main site</a>.</p>\n`
  );
}
run("node sync.mjs", { EDITION: "beta" }); // leave the working copy pointing at the live site
console.log("Built dist/ (Kairos) and dist/beta/ (redirects).");
