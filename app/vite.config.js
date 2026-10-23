import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const page = (f) => resolve(import.meta.dirname, f);
// Each build gets an id. Pages compare it with version.json so a stale cached copy reloads itself.
const build = Date.now().toString(36);

const origin = (u) => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) ? x.origin : "";
  } catch {
    return "";
  }
};

/**
 * A Content Security Policy for every page. GitHub Pages can't send headers, so it goes in a <meta>
 * tag. Pages may only run Kairos's own scripts, and may only talk to the places Kairos needs:
 * the Base network, Coinbase (sign-in, payments), the Kairos money server and the waitlist sheet.
 * Anything injected into a page can't load code or send data anywhere else.
 */
function securityPolicy() {
  const cfg = JSON.parse(readFileSync(page("src/site-config.json"), "utf8"));
  const settings = cfg.settings || {};
  const dep = cfg.deployment || {};
  const local = dep.chainId === 31337;
  const rpc = origin(dep.rpcUrl || (local ? "http://127.0.0.1:8545" : "https://sepolia.base.org"));
  const connect = [
    "'self'",
    rpc,
    "https://api.cdp.coinbase.com", // Coinbase sign-in and sponsored transactions
    "https://cca-lite.coinbase.com", // the Coinbase SDK's error reporting
    origin(settings.moneyApi || ""),
    settings.waitlistUrl ? "https://script.google.com https://script.googleusercontent.com" : "",
    local ? "http://localhost:8787 http://127.0.0.1:8545" : "",
  ];
  const frames = ["https://pay.coinbase.com", "https://secure-wallet.cdp.coinbase.com", local ? "'self'" : ""];
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${[...new Set(connect.filter(Boolean).join(" ").split(" "))].join(" ")}`,
    `frame-src ${frames.filter(Boolean).join(" ")}`,
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(local ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
  return {
    name: "security-policy",
    apply: "build",
    transformIndexHtml(html) {
      const tags =
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n` +
        `  <meta name="referrer" content="strict-origin-when-cross-origin" />`;
      if (!html.includes('<meta charset="utf-8" />')) throw new Error("A page is missing <meta charset>, so it can't get its security policy.");
      return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n  ${tags}`);
    },
  };
}

export default defineConfig({
  base: "./",
  define: { __BUILD_ID__: JSON.stringify(build) },
  plugins: [
    securityPolicy(),
    {
      name: "version-file",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build }) + "\n" });
      },
    },
  ],
  build: {
    // Everything lands in one flat folder (no "assets" subfolder).
    assetsDir: "",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // no file names starting with "_" (some hosts hide those)
      output: { chunkFileNames: (c) => `${c.name.replace(/^_+/, "")}-[hash].js` },
      input: {
        main: page("index.html"),
        app: page("app.html"),
        draws: page("draws.html"),
        how: page("how-it-works.html"),
        privacy: page("privacy.html"),
        security: page("security.html"),
        caseStudy: page("case-study.html"),
        control: page("control.html"),
        deploy: page("deploy.html"),
      },
    },
  },
});
