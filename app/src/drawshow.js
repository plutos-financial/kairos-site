// "How the winners are picked": a draw, shown step by step.
//
//   1. Everyone's entries are lined up. Each saver gets a stretch of the line as long as their savings
//      times how long they were saved this round (the vault's snapshot, read straight from the chain).
//   2. A random number arrives: from Chainlink VRF for real draws, from this browser for pretend ones.
//   3. For prize k (k = 0, 1, 2, …) the number is mixed with k (keccak256), divided by the length of
//      the line, and the remainder is a spot on the line. Whoever's stretch holds that spot wins prize k.
//
// That is exactly KairosVault.fulfillRandomness, redone in the browser. For real draws the result is
// checked against the winners the blockchain recorded.
//
// Three ways in: watchDraw(id) as Chainlink answers, replayDraw(id) for a finished draw, and
// playPretend(...) for a pretend draw (pretend.js).
import { keccak256, encodeAbiParameters, toHex, hexToBigInt, getAddress } from "viem";
import abis from "./abis.json";
import { $, state, fmt, read, sleep, usesChainlink } from "./core.js";
import { podiumHTML, groupWinners, myWin, saverName, hueOf } from "./winners-ui.js";
import "./drawshow.css";

// Where KairosVault keeps each draw's line (from `forge inspect KairosVault storageLayout`).
// drawUsers[drawId] and drawCumWeights[drawId] are internal, so they're read from storage.
const SLOT_USERS = 36n;
const SLOT_CUM = 37n;
const U256x2 = [{ type: "uint256" }, { type: "uint256" }];

/** keccak256(abi.encode(randomNumber, k)), as the vault computes it for prize k. */
export const ticketHash = (word, k) => hexToBigInt(keccak256(encodeAbiParameters(U256x2, [BigInt(word), BigInt(k)])));

/** Index of the saver whose stretch of the line holds `ticket` (same binary search as the vault). */
export function findWinner(cum, ticket) {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > ticket) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The line exactly as the vault saved it when the round closed: savers in order, running totals. */
export async function drawSnapshot(drawId, entrants, totalWeight) {
  const n = Number(entrants);
  if (!n || n > 2000) return null;
  try {
    const vault = state.cfg.vault;
    const head = (slot) => keccak256(encodeAbiParameters(U256x2, [BigInt(drawId), slot]));
    const at = (slot) => state.pub.getStorageAt({ address: vault, slot: head(slot) });
    const [lenU, lenC] = await Promise.all([at(SLOT_USERS), at(SLOT_CUM)]);
    if (hexToBigInt(lenU || "0x0") !== BigInt(n) || hexToBigInt(lenC || "0x0") !== BigInt(n)) return null; // not the layout we expect
    const items = (slot) => {
      const base = hexToBigInt(keccak256(head(slot)));
      return Promise.all(Array.from({ length: n }, (_, i) => state.pub.getStorageAt({ address: vault, slot: toHex(base + BigInt(i), { size: 32 }) })));
    };
    const [u, c] = await Promise.all([items(SLOT_USERS), items(SLOT_CUM)]);
    const users = u.map((x) => getAddress("0x" + String(x).slice(-40)));
    const cum = c.map((x) => hexToBigInt(x));
    for (let i = 1; i < n; i++) if (cum[i] <= cum[i - 1]) return null;
    if (totalWeight !== undefined && cum[n - 1] !== BigInt(totalWeight)) return null;
    return { users, cum, total: cum[n - 1] };
  } catch (e) {
    console.warn("Couldn't read the draw's entries line", e);
    return null;
  }
}

// ------------------------------------------------------------------ the overlay

let run = 0; // each show gets a number; starting another (or closing) stops the old one
let fast = false; // "Skip to the winners"
let pinAt = 0;
let onAgain = null;
const STOP = Symbol("stopped");
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const speed = () => (fast ? 0 : reduced() ? 0.4 : 1);
async function pause(ms, id) {
  if (ms * speed() > 0) await sleep(ms * speed());
  if (id !== run) throw STOP;
}
const pct = (a, total) => (total > 0n ? Number((BigInt(a) * 1_000_000n) / BigInt(total)) / 10_000 : 0);

function overlay() {
  if ($("ds")) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="ds" class="ds" role="dialog" aria-modal="true" aria-labelledby="dsTitle" hidden>
      <canvas id="dsConfetti" aria-hidden="true"></canvas>
      <div class="ds-card">
        <button class="ds-x" id="dsX" type="button" aria-label="Close">&times;</button>
        <p class="ds-kicker" id="dsKicker"></p>
        <h2 class="ds-title" id="dsTitle">How the winners are picked</h2>
        <p class="ds-sub" id="dsSub"></p>
        <ol class="ds-steps" id="dsSteps" aria-label="Steps">
          <li data-s="1">Entries lined up</li>
          <li data-s="2">Random number</li>
          <li data-s="3">Winners picked</li>
        </ol>

        <div id="dsShow" class="ds-show">
          <section class="ds-block" id="dsLineBlock">
            <div class="ds-bh"><span class="ds-n">1</span><div><b>Everyone's entries, lined up</b><p>Each saver gets a stretch of the line: their savings times how long they were saved this round.</p></div></div>
            <div class="ds-line-wrap">
              <div class="ds-line" id="dsLine"></div>
              <div class="ds-marks" id="dsMarks"></div>
              <div class="ds-pin" id="dsPin" hidden><span id="dsPinLabel"></span></div>
            </div>
            <div class="ds-legend" id="dsLegend"></div>
          </section>

          <section class="ds-block" id="dsRngBlock" hidden>
            <div class="ds-bh"><span class="ds-n">2</span><div><b id="dsRngTitle">Chainlink sends a random number</b><p id="dsRngNote"></p></div></div>
            <div class="ds-hex" id="dsHex" aria-live="polite"></div>
          </section>

          <section class="ds-block" id="dsPickBlock" hidden>
            <div class="ds-bh"><span class="ds-n">3</span><div><b>The number picks a spot on the line for each prize</b><p>It's mixed with the prize number and scaled to the line. Whoever's stretch the spot lands in wins that prize.</p></div></div>
            <ol class="ds-picks" id="dsPicks"></ol>
          </section>
        </div>

        <div id="dsResult" class="ds-result" hidden>
          <div id="dsPodium"></div>
          <p class="you-won" id="dsMine" hidden></p>
          <p class="ds-verify" id="dsVerify"></p>
          <details class="ds-math">
            <summary>The exact math</summary>
            <p>For prize <i>k</i> (counting from 0), the vault computes <code>keccak256(randomNumber, k)</code>, divides it by the length of the line (everyone's savings &times; seconds saved) and keeps the remainder. That remainder is a spot on the line, and the saver whose stretch contains it wins prize <i>k</i>. The code is <code>KairosVault.fulfillRandomness</code>, and the random number, the line and the winners are all stored on the blockchain, so anyone can redo it.</p>
          </details>
        </div>

        <div class="ds-actions">
          <button id="dsSkip" class="btn btn-ghost" type="button">Skip to the winners</button>
          <button id="dsBack" class="btn btn-ghost" type="button" hidden>See how they were picked</button>
          <button id="dsAgain" class="btn btn-outline btn-lg" type="button" hidden>Draw again</button>
          <button id="dsDone" class="btn btn-primary btn-lg" type="button" hidden>Done</button>
        </div>
      </div>
    </div>`
  );
  $("dsX").onclick = closeShow;
  $("dsDone").onclick = closeShow;
  $("dsSkip").onclick = () => {
    fast = true;
    $("dsSkip").disabled = true;
  };
  $("dsBack").onclick = () => {
    const back = $("dsShow").hidden;
    $("dsShow").hidden = !back;
    $("dsResult").hidden = back;
    $("dsBack").textContent = back ? "Back to the winners" : "See how they were picked";
  };
  $("dsAgain").onclick = () => onAgain?.();
  addEventListener("keydown", (e) => e.key === "Escape" && !$("ds").hidden && closeShow());
}

export function closeShow() {
  run++; // stops whatever was playing
  const o = $("ds");
  if (o) o.hidden = true;
  document.documentElement.classList.remove("ds-open");
}

function begin({ kicker, title, sub = "" }) {
  overlay();
  const id = ++run;
  $("ds").classList.remove("is-pretend");
  fast = false;
  pinAt = 0;
  onAgain = null;
  $("dsKicker").textContent = kicker;
  $("dsTitle").textContent = title;
  $("dsSub").innerHTML = sub;
  $("dsShow").hidden = false;
  $("dsResult").hidden = true;
  $("dsRngBlock").hidden = true;
  $("dsRngBlock").classList.remove("compact");
  $("dsPickBlock").hidden = true;
  $("dsLineBlock").hidden = false;
  for (const k of ["dsLine", "dsMarks", "dsLegend", "dsPicks", "dsHex", "dsPodium", "dsVerify"]) $(k).innerHTML = "";
  $("dsMine").hidden = true;
  $("dsPin").hidden = true;
  $("dsSkip").hidden = false;
  $("dsSkip").disabled = false;
  $("dsBack").hidden = true;
  $("dsBack").textContent = "See how they were picked";
  $("dsAgain").hidden = true;
  $("dsDone").hidden = true;
  $("dsSteps").hidden = false;
  setStep(1);
  $("ds").hidden = false;
  $("ds").scrollTop = 0;
  document.documentElement.classList.add("ds-open");
  $("dsX").focus();
  return id;
}

function setStep(n) {
  $("dsSteps").querySelectorAll("li").forEach((li) => {
    const k = Number(li.dataset.s);
    li.className = k < n ? "done" : k === n ? "now" : "";
  });
}

/** A message instead of a draw (nobody saving yet, empty prize pool, …). */
function notice(text) {
  $("dsShow").hidden = true;
  $("dsSteps").hidden = true;
  $("dsSub").textContent = text;
  $("dsSkip").hidden = true;
  $("dsDone").hidden = false;
  $("dsDone").focus();
}

// ------------------------------------------------------------------ 1. the line

function renderLine(line, me) {
  const el = $("dsLine");
  if (!line.users) {
    el.innerHTML = `<div class="ds-seg plain" style="left:0;width:100%"></div>`;
    $("dsLegend").innerHTML = `<span class="ds-key more">The line for this draw couldn't be loaded, but every spot below is exact.</span>`;
    return;
  }
  const mine = me ? me.toLowerCase() : "";
  let prev = 0n;
  const rows = line.users.map((u, i) => {
    const w = line.cum[i] - prev;
    const left = pct(prev, line.total);
    prev = line.cum[i];
    return { u, w, i, left, width: pct(w, line.total), me: u.toLowerCase() === mine };
  });
  el.innerHTML = rows
    .map(
      (r) =>
        `<div class="ds-seg${r.me ? " me" : ""}${r.i % 2 ? " alt" : ""}" data-i="${r.i}" title="${saverName(r.u, me)}" style="left:${r.left}%;width:${r.width}%;--h:${hueOf(r.u)};--d:${Math.min(r.i, 30) * 30}ms">${r.me && r.width >= 7 ? "<span>You</span>" : ""}</div>`
    )
    .join("");
  // legend: the biggest stretches, and always you
  const top = [...rows].sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : 0));
  const shown = top.slice(0, 5);
  const you = rows.find((r) => r.me);
  if (you && !shown.includes(you)) shown.push(you);
  const more = rows.length - shown.length;
  $("dsLegend").innerHTML =
    shown.map((r) => `<span class="ds-key${r.me ? " me" : ""}"><i style="--h:${hueOf(r.u)}"></i>${saverName(r.u, me)}</span>`).join("") +
    (more > 0 ? `<span class="ds-key more">+${more} more saver${more === 1 ? "" : "s"}</span>` : "") +
    `<span class="ds-key more">${rows.length} saver${rows.length === 1 ? "" : "s"} in this draw</span>`;
}

// ------------------------------------------------------------------ 2. the random number

const HEX = "0123456789abcdef";
let scrambleTimer = null;
let revealed = "";
function paintHex() {
  const rest = Array.from({ length: 64 - revealed.length }, () => HEX[(Math.random() * 16) | 0]).join("");
  $("dsHex").innerHTML = `<span class="hx-p">0x</span><span class="hx-on">${revealed}</span><span class="hx-off">${rest}</span>`;
}
function startScramble() {
  revealed = "";
  clearInterval(scrambleTimer);
  paintHex();
  scrambleTimer = setInterval(paintHex, 70);
}
async function revealNumber(word, id) {
  const full = BigInt(word).toString(16).padStart(64, "0");
  const ms = 1300 * speed();
  const t0 = performance.now();
  while (revealed.length < 64) {
    if (id !== run) break;
    const p = ms > 0 ? Math.min(1, (performance.now() - t0) / ms) : 1;
    revealed = full.slice(0, Math.ceil(64 * p));
    paintHex();
    if (p >= 1) break;
    await sleep(40);
  }
  clearInterval(scrambleTimer);
  revealed = full;
  paintHex();
  $("dsHex").classList.add("in");
  if (id !== run) throw STOP;
}

// ------------------------------------------------------------------ 3. the picks

function setPin(x, text) {
  const label = $("dsPinLabel");
  $("dsPin").style.left = `${x}%`;
  label.textContent = text ?? `${x.toFixed(1)}%`;
  label.style.transform = `translateX(${x < 8 ? -10 : x > 92 ? -90 : -50}%)`;
}

/** Slides the pin to spot `to` (a %), sweeping `laps` times around the line first, like a wheel. */
function movePin(to, ms, laps, id) {
  $("dsPin").hidden = false;
  const from = pinAt;
  const dist = (to - from + 100) % 100 + 100 * laps;
  const d = ms * speed();
  pinAt = to;
  if (d <= 0) {
    setPin(to);
    return Promise.resolve();
  }
  return new Promise((done) => {
    const t0 = performance.now();
    const step = (t) => {
      if (id !== run) return done();
      const p = Math.min(1, (t - t0) / d);
      const e = 1 - Math.pow(1 - p, 3);
      setPin((from + dist * e) % 100);
      if (p < 1) requestAnimationFrame(step);
      else {
        setPin(to);
        done();
      }
    };
    requestAnimationFrame(step);
  });
}

const shortHash = (h) => {
  const x = h.toString(16).padStart(64, "0");
  return `0x${x.slice(0, 6)}…${x.slice(-4)}`;
};

async function pickAll({ word, line, amounts, chainWinners, me }, id) {
  $("dsPickBlock").hidden = false;
  setStep(3);
  // Small screens: keep the line and the picks in view together.
  $("dsRngBlock").classList.add("compact");
  if (innerHeight < 1000) $("dsLineBlock").scrollIntoView({ behavior: speed() ? "smooth" : "auto", block: "start" });
  const list = $("dsPicks");
  const n = amounts.length;
  const picked = [];
  for (let k = 0; k < n; k++) {
    const h = ticketHash(word, k);
    const t = h % line.total;
    const x = pct(t, line.total);
    const idx = line.users ? findWinner(line.cum, t) : -1;
    const winner = line.users ? line.users[idx] : chainWinners?.[k];
    list.insertAdjacentHTML(
      "beforeend",
      `<li class="pk" id="pk${k}"><span class="pk-n">Prize ${k + 1}</span><b class="pk-amt">${fmt(amounts[k])}</b>` +
        `<span class="pk-math"><code>${shortHash(h)}</code> &rarr; spot ${x.toFixed(2)}%</span><span class="pk-who"><span class="spinner" aria-hidden="true"></span></span></li>`
    );
    list.scrollTop = list.scrollHeight;
    const slow = k < 3;
    await movePin(x, slow ? 1700 : n > 10 ? 320 : 700, slow ? 1 : 0, id);
    if (id !== run) throw STOP;
    setPin(x, `Prize ${k + 1}`);
    $("dsMarks").insertAdjacentHTML("beforeend", `<span class="ds-mark" style="left:${x}%" title="Prize ${k + 1}"></span>`);
    const seg = idx >= 0 ? $("dsLine").querySelector(`[data-i="${idx}"]`) : null;
    if (seg) {
      seg.classList.add("won");
      seg.classList.remove("hit");
      void seg.offsetWidth;
      seg.classList.add("hit");
    }
    const mineWin = me && winner && winner.toLowerCase() === me.toLowerCase();
    $(`pk${k}`).querySelector(".pk-who").innerHTML = winner
      ? `<i style="--h:${hueOf(winner)}"></i><span class="${mineWin ? "me" : ""}">${saverName(winner, me)}</span>`
      : "—";
    picked.push(winner);
    await pause(slow ? 650 : 140, id);
  }
  return picked;
}

// ------------------------------------------------------------------ the winners

function finish({ drawId, winners, amounts, me, verify, title, sub, again, inDraw = true }) {
  setStep(4);
  $("dsTitle").textContent = title;
  $("dsSub").innerHTML = sub;
  $("dsShow").hidden = true;
  $("dsResult").hidden = false;
  const x = { id: drawId, d: { closeTime: BigInt(Math.floor(Date.now() / 1000)) }, winners, amounts };
  $("dsPodium").className = "";
  void $("dsPodium").offsetWidth;
  $("dsPodium").className = "rise";
  $("dsPodium").innerHTML = podiumHTML(x, me);
  const mine = myWin(x, me);
  const pm = $("dsMine");
  pm.hidden = !me || (!inDraw && mine === 0n); // nothing to say to someone who wasn't in it
  pm.className = "you-won" + (mine > 0n ? "" : " quiet");
  pm.textContent = mine > 0n ? (again ? `You'd have won ${fmt(mine)} this time. Pretend money, sadly.` : `You won ${fmt(mine)}. It's already in your savings.`) : again ? "Not you this time." : "Not you this time. Your savings stay exactly where they are.";
  $("dsVerify").innerHTML = verify;
  $("dsSkip").hidden = true;
  $("dsBack").hidden = false;
  $("dsDone").hidden = false;
  $("dsAgain").hidden = !again;
  onAgain = again || null;
  (again ? $("dsAgain") : $("dsDone")).focus();
  if (mine > 0n || !again) confetti(mine > 0n ? 170 : 90);
}

function sameWinners(a, b) {
  return a.length === b.length && a.every((w, i) => w && b[i] && w.toLowerCase() === b[i].toLowerCase());
}

function chainlinkLink() {
  const sub = state.cfg?.subscriptionId;
  return state.cfg?.chainId === 84532 && sub ? `https://vrf.chain.link/base-sepolia/${sub}` : "";
}

/** The transaction where the random number arrived (recent draws only; public nodes limit how far back). */
async function awardTx(drawId) {
  try {
    const latest = await state.pub.getBlockNumber();
    const logs = await state.pub.getContractEvents({
      address: state.cfg.vault,
      abi: abis.KairosVault,
      eventName: "DrawAwarded",
      args: { drawId: BigInt(drawId) },
      fromBlock: latest > 9000n ? latest - 9000n : 0n,
      toBlock: latest,
    });
    return logs[0]?.transactionHash || null;
  } catch {
    return null;
  }
}

function verifyLine(ok, tx, hadLine) {
  const links = [];
  if (tx && state.explorer) links.push(`<a href="${state.explorer}/tx/${tx}" target="_blank" rel="noopener noreferrer">The random number on Basescan</a>`);
  const cl = chainlinkLink();
  if (cl && usesChainlink()) links.push(`<a href="${cl}" target="_blank" rel="noopener noreferrer">Kairos on Chainlink</a>`);
  const head = !hadLine
    ? "The spots above come straight from the blockchain's random number."
    : ok
      ? "&check; Your browser redid the math and got the same winners the blockchain recorded."
      : "Your browser's math didn't match the blockchain's record. The blockchain's record is what counts.";
  return `<span class="${ok || !hadLine ? "ok" : "bad"}">${head}</span>${links.length ? `<span class="ds-links">${links.join("")}</span>` : ""}`;
}

// ------------------------------------------------------------------ entry points

/** A finished draw, replayed from what the blockchain stored: the line, Chainlink's number, the winners. */
export async function replayDraw(drawId) {
  const id = begin({ kicker: `Draw #${drawId}`, title: "How the winners were picked" });
  try {
    await playFromChain(drawId, id, false);
  } catch (e) {
    if (e !== STOP) failed(e);
  }
}

/** A draw that just closed: line up the entries, wait for Chainlink's number, then pick, live. */
export async function watchDraw(drawId) {
  const id = begin({ kicker: `Draw #${drawId} · live`, title: "Picking the winners" });
  try {
    await playFromChain(drawId, id, true);
  } catch (e) {
    if (e !== STOP) failed(e);
  }
}

/** Just a message in the draw window (for example when the network can't be reached). */
export function showNotice(kicker, title, text) {
  begin({ kicker, title });
  notice(text);
}

function failed(e) {
  console.error(e);
  notice(e?.message && e.message.length < 200 ? e.message : "Couldn't reach the test network just now. Try again in a moment.");
}

async function playFromChain(drawId, id, live) {
  const me = state.address;
  let [d, winners, amounts, entrants] = await read("vault", "getDraw", [BigInt(drawId)]);
  if (id !== run) throw STOP;
  if (d.prize === 0n && d.awarded) return notice(`Draw #${drawId} had no prize, so nobody was picked.`);
  const line = (await drawSnapshot(drawId, entrants, d.totalWeight)) || { users: null, cum: null, total: d.totalWeight };
  if (id !== run) throw STOP;
  renderLine(line, me);
  await pause(1500, id);

  // 2. the random number
  $("dsRngBlock").hidden = false;
  setStep(2);
  const chainlink = usesChainlink();
  $("dsRngTitle").textContent = chainlink ? "Chainlink sends a random number" : "The network supplies a random number";
  startScramble();
  if (!d.awarded) {
    // Wait for Chainlink. It answers on its own, usually within a minute on the test network.
    const t0 = Date.now();
    for (let i = 0; !d.awarded; i++) {
      const secs = Math.round((Date.now() - t0) / 1000);
      $("dsRngNote").textContent = chainlink
        ? `Kairos asked Chainlink for a number nobody can predict or change. Waiting for the answer… ${secs}s. This usually takes under a minute.`
        : `Waiting for the random number… ${secs}s`;
      if (Date.now() - t0 > 6 * 60_000) {
        clearInterval(scrambleTimer);
        return notice("Chainlink hasn't answered yet. The winners will appear by themselves once it does. Check back in a few minutes.");
      }
      await sleep(2000);
      if (id !== run) throw STOP;
      [d, winners, amounts] = await read("vault", "getDraw", [BigInt(drawId)]);
    }
  } else {
    await pause(900, id);
  }
  const txPromise = awardTx(drawId);
  $("dsRngNote").textContent = chainlink
    ? "It arrives with a cryptographic proof, and the blockchain checks the proof before accepting it. Nobody, including Kairos, can choose it."
    : "On the test network this comes from the chain itself. The live Kairos uses Chainlink.";
  await revealNumber(d.randomWord, id);
  await pause(900, id);

  // 3. the picks
  const picked = await pickAll({ word: d.randomWord, line, amounts, chainWinners: winners, me }, id);
  await pause(900, id);
  const people = groupWinners(winners, amounts).length;
  const total = amounts.reduce((a, b) => a + b, 0n);
  finish({
    drawId,
    winners,
    amounts,
    me,
    title: "The winners",
    sub: `<b>${fmt(total)}</b> went to ${people} saver${people === 1 ? "" : "s"}${live ? "" : ` in draw #${drawId}`}. Prizes go straight into their savings, and nobody's deposit was touched.`,
    verify: verifyLine(Boolean(line.users) && sameWinners(picked, winners), await txPromise, Boolean(line.users)),
    inDraw: Boolean(me && line.users?.some((u) => u.toLowerCase() === me.toLowerCase())),
  });
}

/**
 * A pretend draw with the real savers and pool (pretend.js loads them). Same math, but the random
 * number comes from this browser and nothing is sent anywhere.
 *   s = { drawId, users, cum, total, pool, splits, later }
 */
export async function playPretend(snap, again) {
  let s = snap;
  const me = state.address;
  const id = begin({ kicker: "Pretend draw", title: "How a draw works", sub: "" });
  $("ds").classList.add("is-pretend");
  if (!s.users.length) return notice("Nobody is saving yet, so there's nobody to pick. Save a few test dollars and you'll be the first one on the line.");
  // No interest yet? Still show how it works, with an example prize pool.
  const example = s.pool === 0n;
  if (example) s = { ...s, pool: 25_000_000n };
  try {
    renderLine(s, me);
    await pause(1500, id);
    $("dsRngBlock").hidden = false;
    setStep(2);
    $("dsRngTitle").textContent = "A random number arrives";
    $("dsRngNote").textContent = "Real draws ask Chainlink for this number. This pretend one comes from your browser.";
    startScramble();
    await pause(1600, id);
    const rnd = crypto.getRandomValues(new Uint8Array(32));
    const word = BigInt("0x" + [...rnd].map((b) => b.toString(16).padStart(2, "0")).join(""));
    await revealNumber(word, id);
    await pause(700, id);
    const amounts = [];
    let left = s.pool;
    s.splits.forEach((bps, i) => {
      const amt = i === s.splits.length - 1 ? left : (s.pool * BigInt(bps)) / 10000n;
      left -= amt;
      amounts.push(amt);
    });
    const winners = await pickAll({ word, line: s, amounts, me }, id);
    await pause(800, id);
    const people = groupWinners(winners, amounts).length;
    finish({
      drawId: s.drawId,
      winners,
      amounts,
      me,
      title: "How it could go",
      sub:
        (example ? `The real prize pool hasn't built up any interest yet, so this uses an example <b>${fmt(s.pool)}</b>. ` : "") +
        `If draw #${s.drawId} went like this, ${people === 1 ? `one saver would take home all <b>${fmt(s.pool)}</b>` : `${people} savers would split <b>${fmt(s.pool)}</b>`}. ` +
        (s.later ? `The real one happens ${s.later}.` : "The real one runs as soon as the round ends."),
      verify: `<span class="ok">Real savers and the real prize pool, picked with the same math as a real draw. Nothing was paid out.</span>`,
      again,
      inDraw: Boolean(me && s.users.some((u) => u.toLowerCase() === me.toLowerCase())),
    });
  } catch (e) {
    if (e !== STOP) failed(e);
  }
}

// ------------------------------------------------------------------ confetti

function confetti(count) {
  if (reduced()) return;
  const c = $("dsConfetti");
  const ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ["#f4c24f", "#ffd77a", "#fffcf7", "#2eb5e0"];
  const bits = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 160, y: innerHeight * 0.38,
    vx: (Math.random() - 0.5) * 15, vy: -Math.random() * 14 - 4,
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
    if (t - start < 4200 && !$("ds").hidden) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  setTimeout(() => requestAnimationFrame(frame), 1500);
}
