// Builds the site that GitHub publishes:
//   dist/        Kairos (Chainlink VRF draws, Add money with Apple Pay in Coinbase test mode, wallet)
//   dist/beta/   redirects, so old /beta/ links still work (and admin.html / winners.html -> draws.html)
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

// Old addresses keep working: /beta/<page>.html -> /<page>.html, and the pages that were merged
// into the Draws page. (Keeps ?query and #hash.)
const redirect = (file, to) =>
  writeFileSync(
    new URL(file, dist),
    `<!doctype html><meta charset="utf-8"><title>Kairos</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=${to}">` +
      `<script>location.replace(${JSON.stringify(to)} + location.search + location.hash)</script>` +
      `<p>This page has moved to <a href="${to}">here</a>.</p>\n`
  );
const moved = { "admin.html": "draws.html", "winners.html": "draws.html" };
for (const [f, to] of Object.entries(moved)) redirect(`./${f}`, `./${to}`);
mkdirSync(new URL("./beta/", dist), { recursive: true });
for (const f of readdirSync(dist).filter((f) => f.endsWith(".html"))) {
  const target = moved[f] || (f === "index.html" ? "" : f);
  redirect(`./beta/${f}`, `../${target}`);
}
run("node sync.mjs", { EDITION: "beta" }); // leave the working copy pointing at the live site
console.log("Built dist/ (Kairos) and dist/beta/ (redirects).");
