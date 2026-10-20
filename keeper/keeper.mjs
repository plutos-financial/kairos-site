// Kairos keeper bot: the "Rebalancer" that pokes the contracts on a schedule.
// Every tick it: keeps the cash drawer in its band, closes the draw when the period ends,
// and (for the demo randomness source) finishes pending draws.
//
//   cp .env.example .env   # fill in RPC_URL and KEEPER_PRIVATE_KEY
//   npm install
//   npm start              # runs forever
//   npm run once           # one tick, then exit
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";

const abis = JSON.parse(readFileSync(new URL("../shared/abis.json", import.meta.url)));
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";
const CHAIN_ID = Number(process.env.CHAIN_ID || 84532);
const TICK_SECONDS = Number(process.env.TICK_SECONDS || 60);
const deployment = JSON.parse(
  readFileSync(new URL(`../contracts/deployments/${CHAIN_ID}.json`, import.meta.url))
);
const chain = CHAIN_ID === 84532 ? baseSepolia : { ...foundry, id: CHAIN_ID };

if (!process.env.KEEPER_PRIVATE_KEY) {
  console.error("Set KEEPER_PRIVATE_KEY in keeper/.env (a throwaway test wallet with a little Base Sepolia ETH).");
  process.exit(1);
}
const account = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ chain, account, transport: http(RPC_URL) });

const vault = { address: deployment.vault, abi: abis.KairosVault };
const rng = { address: deployment.randomSource, abi: abis.DemoRandomSource };
const usd = (x) => "$" + Number(formatUnits(x, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 });

async function send(contract, functionName, args = []) {
  const { request } = await pub.simulateContract({ ...contract, functionName, args, account });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  -> ${functionName}(${args.join(",")}) ${receipt.status} ${hash}`);
  return receipt;
}

async function tick() {
  const [cash, fund, pending, queued, r, low, high] = await pub.readContract({ ...vault, functionName: "drawerState" });
  console.log(
    `[${new Date().toISOString()}] drawer ${usd(cash)} (band ${usd(low)}-${usd(high)}, target ${usd(r)}) | T-bills ${usd(fund)} | settling ${usd(pending)} | queued ${usd(queued)}`
  );

  // 1) Rebalance: collect settled redemptions, pay the queue, keep cash in the band.
  try {
    await send(vault, "rebalance");
  } catch (e) {
    console.log("  rebalance skipped:", e.shortMessage || e.message);
  }

  // 2) Close the draw when the period is over.
  const block = await pub.getBlock();
  const nextDraw = await pub.readContract({ ...vault, functionName: "nextDrawTime" });
  const paused = await pub.readContract({ ...vault, functionName: "paused" });
  if (!paused && block.timestamp >= nextDraw) {
    try {
      await send(vault, "closeDraw");
    } catch (e) {
      console.log("  closeDraw skipped:", e.shortMessage || e.message);
    }
  }

  // 3) Finish draws waiting on the demo randomness source (Chainlink VRF does this by itself).
  const current = await pub.readContract({ ...vault, functionName: "currentDrawId" });
  const src = await pub.readContract({ ...vault, functionName: "randomSource" });
  if (src.toLowerCase() === deployment.randomSource.toLowerCase()) {
    for (let id = current - 1n; id >= 1n && id >= current - 3n; id--) {
      const [d] = await pub.readContract({ ...vault, functionName: "getDraw", args: [id] });
      if (!d.awarded && d.prize > 0n) {
        const reqBlock = await pub.readContract({ ...rng, functionName: "requestBlock", args: [id] });
        if (reqBlock > 0n && (await pub.getBlockNumber()) > reqBlock + 1n) {
          try {
            await send(rng, "fulfill", [id]);
          } catch (e) {
            console.log("  fulfill skipped:", e.shortMessage || e.message);
          }
        }
      }
    }
  }
}

const once = process.argv.includes("--once");
console.log(`Kairos keeper on chain ${CHAIN_ID} as ${account.address}, vault ${deployment.vault}`);
await tick();
if (!once) setInterval(() => tick().catch((e) => console.error(e)), TICK_SECONDS * 1000);
