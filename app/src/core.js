// Shared Plutos plumbing: network, contracts, sign-in, and sending actions.
//
// Two ways to sign in:
//   1. Email (Coinbase embedded wallet). The user gets a smart account, actions are
//      sponsored by the Coinbase paymaster on Base Sepolia: no pop-ups, no gas.
//   2. Browser wallet (MetaMask etc.) as a fallback. Each action shows a wallet pop-up.
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  formatUnits,
  encodeFunctionData,
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";
import abis from "./abis.json";
import built from "./site-config.json"; // addresses + settings baked in at build time (see sync.mjs)
import "./fresh.js"; // reloads a stale cached page after a site update

export const $ = (id) => document.getElementById(id);
/** Makes text safe to put inside HTML. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LOCAL = (cfg) => cfg?.chainId === 31337;

// Which copy of the site this is: "demo" (the original) or "beta" (Chainlink draws, Add money, send/receive).
export const EDITION = built.edition === "beta" ? "beta" : "demo";
export const isBeta = EDITION === "beta";
const SAVED_DEPLOYMENT = isBeta ? "kairos.deployment.beta" : "kairos.deployment";


// Prize structures the owner can switch between (basis points of the pool, must add to 10,000).
export const PRIZE_PRESETS = {
  3: [6000, 2500, 1500],
  10: [3000, 1500, 1000, 800, 700, 700, 600, 600, 550, 550],
  20: [2000, 1000, 800, ...Array(16).fill(365), 360],
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const fmt = (x, d = 2) =>
  "$" + Number(formatUnits(x ?? 0n, 6)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export const state = {
  cfg: null, // deployment addresses
  appCfg: {}, // { cdpProjectId }
  chain: null,
  pub: null,
  explorer: null,
  contracts: {},
  mode: null, // "email" | "wallet" | "dev"
  address: null, // the account that holds savings
  email: null,
  walletClient: null,
  lastHashes: [], // every transaction hash from the last act() call
};

// ------------------------------------------------------------------ setup

async function fetchJson(path) {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

export async function loadDeployment() {
  // The official contracts: the file next to the page (so the site can be repointed without a
  // rebuild), or the copy baked into the code.
  const j = await fetchJson("./deployment.json");
  if (j?.vault) return j;
  if (built.deployment?.vault) return built.deployment;
  // Only before the official contracts exist: the ones this browser just set up on deploy.html.
  // (Never on top of the official ones, so nothing saved in a browser can quietly swap them.)
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_DEPLOYMENT) || "null");
    if (saved?.vault && /^0x[0-9a-fA-F]{40}$/.test(saved.vault)) return saved;
  } catch {}
  return null;
}

export async function setup() {
  const cfg = await loadDeployment();
  state.appCfg = { ...built.settings, ...((await fetchJson("./kairos-settings.json")) || {}) };
  if (!cfg) return false;
  state.cfg = cfg;
  if (cfg.chainId === 84532) {
    state.chain = baseSepolia;
    state.explorer = "https://sepolia.basescan.org";
  } else {
    state.chain = { ...foundry, id: cfg.chainId };
    state.explorer = null;
  }
  const rpc = cfg.rpcUrl || (cfg.chainId === 84532 ? "https://sepolia.base.org" : "http://127.0.0.1:8545");
  // batch: many reads go out as one HTTP request, which keeps the public RPC from rate-limiting us
  state.pub = createPublicClient({ chain: state.chain, transport: http(rpc, { batch: { wait: 16 } }) });
  state.contracts = {
    vault: { address: cfg.vault, abi: abis.KairosVault },
    usdc: { address: cfg.usdc, abi: abis.MockUSDC },
    tbill: { address: cfg.tbill, abi: abis.MockTBill },
    // The beta's draws use Chainlink VRF; the demo uses a simple on-chain random source.
    rng: cfg.vrf ? { address: cfg.vrf, abi: abis.ChainlinkVRFSource } : { address: cfg.randomSource, abi: abis.DemoRandomSource },
  };
  return true;
}

/** True when draws use Chainlink VRF (Chainlink calls back with the random number by itself). */
export const usesChainlink = () => Boolean(state.cfg?.vrf);
export const saveDeployment = (cfg) => {
  try {
    localStorage.setItem(SAVED_DEPLOYMENT, JSON.stringify(cfg));
  } catch {}
};

export const read = (c, functionName, args = []) => state.pub.readContract({ ...state.contracts[c], functionName, args });

/**
 * Who may run real draws: the on-chain owner, or a signed-in email on the drawAdmins list
 * (stored as SHA-256 hashes so the address isn't sitting in the page). Everyone else gets pretend draws.
 * This only decides what the website shows. On-chain, a round can't close before its countdown ends,
 * and only the owner can shorten it.
 */
export async function canRunDraws(owner) {
  if (!state.address) return false;
  if (owner && state.address.toLowerCase() === owner.toLowerCase()) return true;
  if (!state.email) return false;
  const admins = (state.appCfg.drawAdmins || []).map((h) => String(h).toLowerCase());
  if (!admins.length) return false;
  const bytes = new TextEncoder().encode(state.email.trim().toLowerCase());
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return admins.includes(hash);
}

export const emailAvailable = () => Boolean(state.appCfg.cdpProjectId) && state.cfg?.chainId === 84532;
/** Local testing only: ?mock signs in with Coinbase's mock wallet on a local chain. */
export const mockSignIn = () => LOCAL(state.cfg) && new URLSearchParams(location.search).has("mock");

// ------------------------------------------------------------------ email sign-in (Coinbase embedded wallet)

let cdp; // the Coinbase SDK, loaded only when needed
let cdpReady;

async function loadCdp() {
  if (cdpReady) return cdpReady;
  cdpReady = (async () => {
    cdp = await import("@coinbase/cdp-core");
    const mock = mockSignIn();
    await cdp.initialize({
      projectId: mock ? "mock-project" : state.appCfg.cdpProjectId,
      ethereum: { createOnLogin: "smart" },
      useMock: mock,
    });
    return cdp;
  })();
  return cdpReady;
}

async function smartAccountOf(user) {
  let addr = user?.evmSmartAccountObjects?.[0]?.address || user?.evmSmartAccounts?.[0];
  if (!addr) addr = await cdp.createEvmSmartAccount();
  return addr;
}

/** Restores an email session from a previous visit. Returns true if signed in. */
export async function resumeEmailSession() {
  if (!emailAvailable() && !mockSignIn()) return false;
  try {
    await loadCdp();
    if (!(await cdp.isSignedIn())) return false;
    const user = await cdp.getCurrentUser();
    state.address = await smartAccountOf(user);
    state.email = user?.authenticationMethods?.email?.email || null;
    state.mode = "email";
    return true;
  } catch (e) {
    console.warn("Email session not restored", e);
    return false;
  }
}

/** The Coinbase sign-in token, so the Plutos money server can check who's asking. Null if not signed in by email. */
export async function accessToken() {
  if (state.mode !== "email" || !cdp) return null;
  try {
    return await cdp.getAccessToken();
  } catch {
    return null;
  }
}

export async function startEmailSignIn(email) {
  await loadCdp();
  const r = await cdp.signInWithEmail({ email });
  return r.flowId;
}

export async function finishEmailSignIn(flowId, otp, email) {
  await loadCdp();
  const { user } = await cdp.verifyEmailOTP({ flowId, otp });
  state.address = await smartAccountOf(user);
  state.email = email || user?.authenticationMethods?.email?.email || null;
  state.mode = "email";
  return state.address;
}

// ------------------------------------------------------------------ browser wallet (fallback)

export async function connectBrowserWallet() {
  if (!window.ethereum) throw new Error("No browser wallet found. Use email sign-in, or install MetaMask.");
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const hexId = "0x" + state.chain.id.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e.code === 4902 && state.chain.id === 84532) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: "Base Sepolia",
            nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://sepolia.base.org"],
            blockExplorerUrls: ["https://sepolia.basescan.org"],
          },
        ],
      });
    } else throw e;
  }
  state.walletClient = createWalletClient({ chain: state.chain, account: addr, transport: custom(window.ethereum) });
  state.address = addr;
  state.mode = "wallet";
  window.ethereum.on?.("accountsChanged", () => location.reload());
  return addr;
}

/** Local testing only: ?devkey=0x… on a local chain signs with a local key. */
export function connectDevKey() {
  const k = new URLSearchParams(location.search).get("devkey");
  if (!k || !LOCAL(state.cfg) || !/^0x[0-9a-fA-F]{64}$/.test(k)) return false;
  const acct = privateKeyToAccount(k);
  state.walletClient = createWalletClient({
    chain: state.chain,
    account: acct,
    transport: http(state.cfg.rpcUrl || "http://127.0.0.1:8545"),
  });
  state.address = acct.address;
  state.mode = "dev";
  return true;
}

export async function signOutAll() {
  if (state.mode === "email" && cdp) await cdp.signOut();
  state.mode = null;
  state.address = null;
  state.email = null;
}

// ------------------------------------------------------------------ sending actions

/**
 * Runs one or more contract calls as a single action.
 *   calls: [{ c: "vault", fn: "deposit", args: [amount], gas?: 1_000_000n }, ...]
 * Email accounts: one sponsored user operation (no pop-up, no gas, all-or-nothing).
 * Browser wallets: one pop-up per call.
 * Returns the transaction hash of the last step.
 */
export async function act(calls, onStatus = () => {}) {
  if (!state.address) throw new Error("Sign in first.");
  state.lastHashes = [];

  // Check every call first so the user gets a clear reason instead of a failed transaction.
  // (Only the first call can be checked on its own: later ones may depend on it.)
  await simulate(calls[0]);

  if (state.mode === "email") {
    onStatus("Sending…");
    const { userOperationHash } = await cdp.sendUserOperation({
      evmSmartAccount: state.address,
      network: "base-sepolia",
      useCdpPaymaster: true,
      calls: calls.map((x) => ({
        to: state.contracts[x.c].address,
        value: 0n,
        data: encodeFunctionData({ abi: state.contracts[x.c].abi, functionName: x.fn, args: x.args || [] }),
      })),
    });
    onStatus("Confirming on Base…");
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const op = await cdp.getUserOperation({ userOperationHash, evmSmartAccount: state.address, network: "base-sepolia" });
      if (op.status === "complete") {
        state.lastHashes = [op.transactionHash];
        await sleep(1500); // let the public RPC catch up before we re-read balances
        return op.transactionHash;
      }
      if (op.status === "failed" || op.status === "dropped") throw new Error("That didn't go through on the network. Refresh the page and try again.");
    }
    throw new Error("Still confirming. Refresh in a minute to see the result.");
  }

  let hash;
  for (let i = 0; i < calls.length; i++) {
    const x = calls[i];
    if (i > 0) await simulate(x, 5);
    onStatus(state.mode === "wallet" ? `Confirm in your wallet (${i + 1} of ${calls.length})…` : "Sending…");
    const { request } = await state.pub.simulateContract({
      ...state.contracts[x.c],
      functionName: x.fn,
      args: x.args || [],
      account: state.walletClient.account,
      ...(x.gas ? { gas: x.gas } : {}), // a fixed gas limit for calls whose cost depends on randomness
    });
    hash = await state.walletClient.writeContract(request);
    state.lastHashes.push(hash);
    onStatus("Confirming on Base…");
    const r = await state.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("The transaction failed on-chain.");
  }
  await sleep(1000);
  return hash;
}

async function simulate(x, tries = 1) {
  for (let i = 0; ; i++) {
    try {
      await state.pub.simulateContract({
        ...state.contracts[x.c],
        functionName: x.fn,
        args: x.args || [],
        account: state.address,
      });
      return;
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1500);
    }
  }
}

export function friendlyError(e) {
  const msg = e?.shortMessage || e?.message || String(e);
  if (/paymaster|sponsor|allowlist|policy/i.test(msg))
    return "Coinbase's gas sponsor turned this down. In the Coinbase developer portal, open Paymaster and either leave the contract allowlist empty or add all four Plutos contracts.";
  if (e?.code === 4001 || /user rejected|user denied|rejected the request|cancel/i.test(msg)) return "You cancelled it.";
  const reverted = typeof e?.walk === "function" ? e.walk((x) => x?.name === "ContractFunctionRevertedError") : null;
  const name = reverted?.data?.errorName;
  const reason = reverted?.reason;
  const known = {
    ERC20InsufficientAllowance: "Plutos isn't approved to use your test dollars yet. Try again.",
    ERC20InsufficientBalance: "You don't have enough test dollars.",
    EnforcedPause: "Deposits are paused right now.",
    OwnableUnauthorizedAccount: "Only the owner account can do that.",
  };
  if (name && known[name]) return known[name];
  if (reason) {
    const r = reason.replace(/^(kairos|fund): /, "");
    if (/faucet: wait an hour/.test(r)) return "You already got test dollars this hour. Try again later.";
    if (/topup: over the daily limit/.test(r)) return "That's over the $10,000-a-day limit for test dollars. Try a smaller amount.";
    if (/topup: up to/.test(r)) return "You can add up to $1,000,000 at a time. Add it in a few goes.";
    if (/last draw still picking/.test(r)) return "The last draw is still paying its winners. Try again in a minute.";
    if (/not ready to award/.test(r)) return "Those winners were already paid, or the random number hasn't arrived yet.";
    return r.charAt(0).toUpperCase() + r.slice(1) + ".";
  }
  if (name) return name;
  return msg.split("\n")[0];
}

export function txLink(hash) {
  return state.explorer && /^0x[0-9a-fA-F]{64}$/.test(hash || "") ? `<a href="${state.explorer}/tx/${hash}" target="_blank" rel="noopener noreferrer">View receipt</a>` : "";
}

let toastTimer;
/** An error as a toast, as plain text (error messages can contain anything). */
export const toastError = (e, ms = 6000) => toast(esc(friendlyError(e)), true, ms);
/** `html` is trusted markup written by Plutos; anything from outside goes through esc() first. */
export function toast(html, err = false, ms = 6000) {
  const t = $("toast");
  if (!t) return;
  t.innerHTML = html;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.className = "toast"), ms);
}

export function humanDuration(s) {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? "" : "s"}`;
  return `${s} seconds`;
}

// ------------------------------------------------------------------ the draw line, a page at a time

const PAGE = 500n;

/** Savers in order and running totals, from pages of [savers, entries] (people with no entries left out). */
export function lineFromPages(pages) {
  const users = [];
  const cum = [];
  let total = 0n;
  for (const [savers, weights] of pages)
    savers.forEach((a, i) => {
      if (weights[i] === 0n) return;
      users.push(getAddress(a));
      cum.push((total += weights[i]));
    });
  return { users, cum, total };
}

/** Reads a line a page at a time: fn(start, count) -> [savers, entries]. */
export const readPages = (size, fn) =>
  Promise.all(Array.from({ length: Math.ceil(Number(size) / Number(PAGE)) }, (_, p) => fn(BigInt(p) * PAGE, PAGE)));
