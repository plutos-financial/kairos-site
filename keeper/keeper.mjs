// Plutos keeper: runs the draws by itself. GitHub Actions runs one tick every few minutes
// (.github/workflows/keeper.yml); it can also run on any computer.
//
// Each tick, only doing what's needed (every step is something anyone is allowed to do):
//   1. Rebalance the cash drawer, if it's outside its band or withdrawals are waiting.
//   2. Close the round once it's over (the vault then asks Chainlink for a random number).
//   3. Pay the winners if the random number has arrived but they weren't paid in the same step.
//   4. For the local demo randomness source only: finish the pending draw.
//
//   KEEPER_PRIVATE_KEY=0x... node keeper.mjs --once     # one tick, then exit (what GitHub runs)
//   KEEPER_PRIVATE_KEY=0x... node keeper.mjs            # keep ticking every TICK_SECONDS
//
// Environment: KEEPER_PRIVATE_KEY (a throwaway test wallet with a little Base Sepolia ETH),
// RPC_URL (default https://sepolia.base.org), CHAIN_ID (84532), EDITION (beta), TICK_SECONDS (60).
import { readFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, fallback, formatUnits, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";

try {
  await import("dotenv/config");
} catch {}

const abis = JSON.parse(readFileSync(new URL("../shared/abis.json", import.meta.url)));
const CHAIN_ID = Number(process.env.CHAIN_ID || 84532);
const EDITION = process.env.EDITION || "beta";
const RPC_URL = process.env.RPC_URL || (CHAIN_ID === 31337 ? "http://127.0.0.1:8545" : "https://sepolia.base.org");
const TICK_SECONDS = Number(process.env.TICK_SECONDS || 60);
const file = new URL(`../contracts/deployments/${CHAIN_ID}${EDITION === "beta" ? "-beta" : ""}.json`, import.meta.url);
if (!existsSync(file)) {
  console.log(`No deployment file for chain ${CHAIN_ID} (${EDITION}) yet. Nothing to do.`);
  process.exit(0);
}
const deployment = JSON.parse(readFileSync(file));
const chain = CHAIN_ID === 84532 ? baseSepolia : { ...foundry, id: CHAIN_ID };

// In GitHub Actions, problems also show up as annotations on the run, readable without the full log.
const inActions = Boolean(process.env.GITHUB_ACTIONS);
const note = (level, msg) => {
  console.log(msg);
  if (inActions) console.log(`::${level} title=keeper::${msg.replace(/\r?\n/g, " ")}`);
};

if (!process.env.KEEPER_PRIVATE_KEY) {
  console.log("KEEPER_PRIVATE_KEY isn't set, so the keeper can't send anything. (In GitHub: Settings > Secrets > Actions.)");
  process.exit(0);
}
// MetaMask exports keys without the 0x, and copying can add spaces, quotes or a line break: accept all of those.
const rawKey = process.env.KEEPER_PRIVATE_KEY.trim().replace(/^["']|["']$/g, "").trim();
const key = /^0x/i.test(rawKey) ? "0x" + rawKey.slice(2) : "0x" + rawKey;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  note("error", `KEEPER_PRIVATE_KEY doesn't look like a private key (it should be 64 letters and numbers, with or without 0x; this one has ${rawKey.replace(/^0x/i, "").length} characters). Replace the secret in GitHub: Settings > Secrets and variables > Actions.`);
  process.exit(1);
}
const account = privateKeyToAccount(key);
// Base's public node limits how often anyone can call it, and GitHub's machines share addresses,
// so fall back to other public nodes when it says no.
const RPCS = process.env.RPC_URL
  ? [RPC_URL]
  : CHAIN_ID === 84532
    ? ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org"]
    : [RPC_URL];
const transport = fallback(RPCS.map((u) => http(u, { retryCount: 2, retryDelay: 800 })));
const pub = createPublicClient({ chain, transport });
const wallet = createWalletClient({ chain, account, transport });

const vault = { address: deployment.vault, abi: abis.KairosVault };
const usd = (x) => "$" + Number(formatUnits(x, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const read = (functionName, args = []) => pub.readContract({ ...vault, functionName, args });

async function send(contract, functionName, args = [], gas) {
  const { request } = await pub.simulateContract({ ...contract, functionName, args, account, ...(gas ? { gas } : {}) });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  -> ${functionName}(${args.join(",")}) ${receipt.status} ${hash}`);
  if (receipt.status !== "success") throw new Error(`${functionName} failed on-chain`);
  return receipt;
}

async function tick() {
  const [block, eth] = await Promise.all([pub.getBlock(), pub.getBalance({ address: account.address })]);
  const now = block.timestamp;
  const [[cash, , pending, queued, , low, high], nextDraw, paused, current, prizeReserve, interest] = await Promise.all([
    read("drawerState"),
    read("nextDrawTime"),
    read("paused"),
    read("currentDrawId"),
    read("prizeReserve"),
    read("availableInterest"),
  ]);
  console.log(
    `[${new Date().toISOString()}] round ${current} · next draw ${nextDraw <= now ? "due now" : `in ${Math.round(Number(nextDraw - now) / 60)} min`} · prize pool ~${usd(prizeReserve + (interest * 85n) / 100n)} · drawer ${usd(cash)} · keeper ${Number(formatEther(eth)).toFixed(5)} ETH`
  );
  if (eth === 0n) {
    note("error", `The keeper wallet ${account.address} has no Base Sepolia ETH, so it can't run the draws. Send it about 0.01 test ETH from a faucet.`);
    process.exitCode = 1;
    return;
  }
  if (eth < 200_000_000_000_000n) note("warning", `The keeper wallet ${account.address} is low on test ETH (${Number(formatEther(eth)).toFixed(5)}). Top it up from a faucet soon.`);

  // 1. Rebalance only when it would do something.
  if (queued > 0n || pending > 0n || cash < low || cash > high) {
    try {
      await send(vault, "rebalance");
    } catch (e) {
      console.log("  rebalance skipped:", e.shortMessage || e.message);
    }
  }

  // 3. (before 2) Pay the winners of a draw whose random number is in.
  const last = current - 1n;
  let lastAwarded = true;
  if (last >= 1n) {
    const [d] = await read("getDraw", [last]);
    lastAwarded = d.awarded;
    if (d.randomReady && !d.awarded) {
      try {
        await send(vault, "awardDraw", [last], 8_000_000n);
        lastAwarded = true;
      } catch (e) {
        console.log("  awardDraw skipped:", e.shortMessage || e.message);
      }
    } else if (!d.awarded && d.prize > 0n) {
      const waited = Number(now - d.closeTime);
      console.log(`  draw ${last} is waiting for its random number (${Math.round(waited / 60)} min).${waited > 3600 ? " If Chainlink never answers, the owner can press retry (retryRandomness)." : ""}`);
      // 4. The local demo randomness source needs someone to finish it.
      await finishDemoDraw(last);
    }
  }

  // 2. Close the round once it's over.
  if (!paused && now >= nextDraw && lastAwarded) {
    try {
      await send(vault, "closeDraw");
    } catch (e) {
      console.log("  closeDraw skipped:", e.shortMessage || e.message);
    }
  }
}

async function finishDemoDraw(id) {
  if (!abis.DemoRandomSource) return;
  const src = { address: deployment.randomSource, abi: abis.DemoRandomSource };
  try {
    const reqBlock = await pub.readContract({ ...src, functionName: "requestBlock", args: [id] });
    if (reqBlock > 0n && (await pub.getBlockNumber()) > reqBlock + 1n) await send(src, "fulfill", [id], 8_000_000n);
  } catch {
    // Not the demo source (Chainlink answers by itself).
  }
}

const once = process.argv.includes("--once");
console.log(`Plutos keeper on chain ${CHAIN_ID} (${EDITION}) as ${account.address}, vault ${deployment.vault}`);
try {
  await tick();
} catch (e) {
  const msg = (e.shortMessage || e.message || String(e)).split("\n")[0];
  // The public nodes being busy isn't worth an alarm: the next tick, a few minutes later, tries again.
  const busy = /429|rate limit|timed? ?out|fetch failed|ECONNRESET|ENOTFOUND|503|502|HTTP request failed/i.test(msg);
  note(busy ? "warning" : "error", `Tick ${busy ? "skipped, the blockchain node was busy" : "failed"}: ${msg}`);
  if (once && !busy) process.exitCode = 1;
}
if (!once) setInterval(() => tick().catch((e) => console.error("Tick failed:", e.shortMessage || e.message)), TICK_SECONDS * 1000);
