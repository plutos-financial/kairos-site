// Pretend draws: what the next draw could pay, using the real savers and the real prize pool.
// Same picking math as KairosVault.fulfillRandomness, with a random number from this browser.
// Nothing is sent to the network, so anyone can run one, signed in or not. drawshow.js shows it.
import { state, read } from "./core.js";
import { playPretend, showNotice } from "./drawshow.js";

const YEAR = 365n * 24n * 3600n;
let snap = null; // savers and pool, reused by "Draw again" for a minute

async function load() {
  if (snap && Date.now() - snap.at < 60_000) return snap;
  const [block, n, splits, reserve, interest, feeBps, nextDraw, drawId, tokens, navCp, cpTime, apy, speed] = await Promise.all([
    state.pub.getBlock(),
    read("vault", "depositorCount"),
    read("vault", "prizeSplits"),
    read("vault", "prizeReserve"),
    read("vault", "availableInterest"),
    read("vault", "feeBps"),
    read("vault", "nextDrawTime"),
    read("vault", "currentDrawId"),
    read("tbill", "balanceOf", [state.cfg.vault]),
    read("tbill", "navCheckpoint"),
    read("tbill", "checkpointTime"),
    read("tbill", "apyBps"),
    read("tbill", "speed"),
  ]);
  const now = block.timestamp;
  const end = nextDraw > now ? nextDraw : now;
  // Interest still to come before the draw, same formula as MockTBill.nav().
  const nav = (t) => navCp + (navCp * apy * (t - cpTime) * speed) / (10000n * YEAR);
  const accrue = tokens > 0n ? (tokens * (nav(end) - nav(now))) / 10n ** 18n : 0n;
  const pool = reserve + ((interest + accrue) * (10000n - feeBps)) / 10000n;

  // The line the vault would save if the round closed at the draw time: same order, same weights.
  const addrs = await Promise.all(Array.from({ length: Number(n) }, (_, i) => read("vault", "depositors", [BigInt(i)])));
  const weights = await Promise.all(addrs.map((a) => read("vault", "weightAt", [a, end])));
  const users = [];
  const cum = [];
  let total = 0n;
  addrs.forEach((a, i) => {
    if (weights[i] === 0n) return;
    users.push(a);
    cum.push((total += weights[i]));
  });
  snap = { at: Date.now(), drawId, users, cum, total, pool, splits: splits.map(BigInt), later: when(Number(end - now)) };
  return snap;
}

function when(sec) {
  if (sec <= 0) return "";
  if (sec < 90) return "in about a minute";
  if (sec < 5400) return `in about ${Math.round(sec / 60)} minutes`;
  if (sec < 172800) return `in about ${Math.round(sec / 3600)} hours`;
  return `in about ${Math.round(sec / 86400)} days`;
}

/** Opens a pretend draw. Safe to call from any page that ran core.js setup(). */
export async function openPretend(fresh = true) {
  if (fresh) snap = null;
  try {
    const s = await load();
    return playPretend(s, () => openPretend(false));
  } catch (e) {
    console.error(e);
    return showNotice("Pretend draw", "How a draw works", "Couldn't reach the test network just now. Try again in a moment.");
  }
}
