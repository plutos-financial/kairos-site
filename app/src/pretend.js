// Pretend draws: what the next draw could pay, using the real savers and the real prize pool.
// Same picking math as KairosVault.fulfillRandomness, with a random number from this browser.
// Nothing is sent to the network, so anyone can run one, signed in or not.
import { keccak256, encodeAbiParameters } from "viem";
import { $, state, fmt, read } from "./core.js";
import { podiumHTML, groupWinners, myWin } from "./winners-ui.js";

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

  const addrs = await Promise.all(Array.from({ length: Number(n) }, (_, i) => read("vault", "depositors", [BigInt(i)])));
  const weights = await Promise.all(addrs.map((a) => read("vault", "weightAt", [a, end])));
  const people = addrs.map((a, i) => ({ a, w: weights[i] })).filter((p) => p.w > 0n);
  const cum = [];
  let total = 0n;
  for (const p of people) cum.push((total += p.w));
  snap = { at: Date.now(), now, end, pool, splits: splits.map(BigInt), drawId, people, cum, total };
  return snap;
}

function pick(s) {
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  const word = BigInt("0x" + [...rnd].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const winners = [];
  const amounts = [];
  let left = s.pool;
  s.splits.forEach((bps, i) => {
    const amt = i === s.splits.length - 1 ? left : (s.pool * bps) / 10000n;
    left -= amt;
    const ticket = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [word, BigInt(i)]))) % s.total;
    let lo = 0, hi = s.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.cum[mid] > ticket) hi = mid;
      else lo = mid + 1;
    }
    winners.push(s.people[lo].a);
    amounts.push(amt);
  });
  return { winners, amounts };
}

function when(sec) {
  if (sec <= 0) return "";
  if (sec < 90) return "in under a minute and a half";
  if (sec < 5400) return `in about ${Math.round(sec / 60)} minutes`;
  if (sec < 172800) return `in about ${Math.round(sec / 3600)} hours`;
  return `in about ${Math.round(sec / 86400)} days`;
}

function overlay() {
  if ($("pretend")) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="pretend" class="reveal pretend" role="dialog" aria-modal="true" aria-labelledby="pTitle" hidden>
      <canvas id="pConfetti" aria-hidden="true"></canvas>
      <div class="reveal-card">
        <p class="w-kicker pretend-kicker">Pretend draw</p>
        <h2 class="reveal-title" id="pTitle">how it could go.</h2>
        <p class="w-sub" id="pSub"></p>
        <div id="pPodium" class="rise"></div>
        <p class="you-won" id="pMine" hidden></p>
        <div class="win-actions">
          <button id="pAgain" class="btn btn-primary btn-lg" type="button">Draw again</button>
          <button id="pClose" class="btn btn-outline btn-lg" type="button">Close</button>
        </div>
        <p class="tiny pretend-note">Real savers and the real prize pool, picked the same way the real draw picks. Nothing was paid out and nothing moved.</p>
      </div>
    </div>`
  );
  $("pClose").onclick = close;
  $("pAgain").onclick = () => run(false);
  addEventListener("keydown", (e) => e.key === "Escape" && close());
}

function close() {
  const o = $("pretend");
  if (o) o.hidden = true;
}

/** Opens the pretend draw. Safe to call from any page that loaded core.js setup(). */
export async function openPretend() {
  overlay();
  snap = null; // fresh numbers when it opens
  return run(true);
}

async function run(first) {
  const o = $("pretend");
  const again = $("pAgain");
  o.hidden = false;
  again.disabled = true;
  if (first) {
    $("pSub").textContent = "Shuffling everyone's entries…";
    $("pPodium").innerHTML = "";
    $("pMine").hidden = true;
  }
  try {
    const s = await load();
    const later = when(Number(s.end - s.now));
    if (!s.people.length) {
      $("pSub").innerHTML = "Nobody is saving yet, so there's nobody to pick. Deposit some test dollars in the app and you'll be the first name in the hat.";
      $("pPodium").innerHTML = "";
      again.hidden = true;
      return;
    }
    if (s.pool === 0n) {
      $("pSub").innerHTML = "The prize pool is still $0. Prizes come from interest, and none has built up yet. Check back in a bit.";
      $("pPodium").innerHTML = "";
      again.hidden = true;
      return;
    }
    again.hidden = false;
    const { winners, amounts } = pick(s);
    const people = groupWinners(winners, amounts).length;
    const x = { id: s.drawId, d: { closeTime: s.end }, winners, amounts };
    $("pSub").innerHTML =
      `If draw #${s.drawId} went like this, ${people === 1 ? `one saver would take home all <b>${fmt(s.pool)}</b>` : `${people} savers would split <b>${fmt(s.pool)}</b>`}. ` +
      (later ? `The real one happens ${later}.` : "The real one runs as soon as the Kairos team starts it.");
    $("pPodium").innerHTML = podiumHTML(x, state.address);
    const mine = myWin(x, state.address);
    const pm = $("pMine");
    pm.className = "you-won" + (mine > 0n ? "" : " quiet");
    pm.hidden = !state.address;
    if (mine > 0n) {
      pm.textContent = `You'd have won ${fmt(mine)} this time. Pretend money, sadly.`;
      confetti();
    } else if (state.address && !s.people.some((p) => p.a.toLowerCase() === state.address.toLowerCase())) {
      pm.textContent = "You're not in this one. Deposit some test dollars in the app to get your name in the hat.";
    } else pm.textContent = "Not you this time. Your savings stay exactly where they are.";
  } catch (e) {
    console.error(e);
    $("pSub").textContent = "Couldn't reach the test network just now. Try again in a moment.";
  } finally {
    again.disabled = false;
    $(first ? "pClose" : "pAgain").focus();
  }
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = $("pConfetti");
  const ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ["#f4c24f", "#ffd77a", "#fffcf7", "#2eb5e0"];
  const bits = Array.from({ length: 120 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 160, y: innerHeight * 0.4,
    vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 14 - 4,
    r: 4 + Math.random() * 5, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (t) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.32; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.a += b.va;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.fillStyle = b.color; ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2); ctx.restore();
    }
    if (t - start < 4000 && !$("pretend").hidden) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  setTimeout(() => requestAnimationFrame(frame), 1600);
}
