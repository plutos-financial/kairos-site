// Public winners page: the latest draw as a podium, the next draw countdown, and past draws.
import { $, fmt, setup, read, toast, state, resumeEmailSession, connectDevKey } from "./core.js";
import { loadDraws, latestWithWinners, podiumHTML, drawTotal, drawWhen, groupWinners, saverName, avatar, myWin } from "./winners-ui.js";
import { openPretend } from "./pretend.js";

let nextDraw = 0n;
let chainOffset = 0;
let pool = 0;
let poolAt = 0;
let rate = 0;
const YEAR = 365 * 24 * 3600;

async function main() {
  if (!(await setup())) return toast("This site isn't connected to contracts yet.", true, 0);
  $("pretendBtn").onclick = () => openPretend();
  // If the visitor is signed in, highlight their own wins. Never blocks the page.
  if (!connectDevKey()) resumeEmailSession().then((ok) => ok && render(true));
  await render();
  setInterval(render, 8000);
  setInterval(tick, 1000);
}

let lastKey = "";
async function render(force = false) {
  try {
    const [block, nd, reserve, interest, feeBps, drawer, apy, speed] = await Promise.all([
      state.pub.getBlock(),
      read("vault", "nextDrawTime"),
      read("vault", "prizeReserve"),
      read("vault", "availableInterest"),
      read("vault", "feeBps"),
      read("vault", "drawerState"),
      read("tbill", "apyBps"),
      read("tbill", "speed"),
    ]);
    chainOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
    nextDraw = nd;
    const keep = Number(10000n - feeBps) / 10000;
    pool = Number(reserve + (interest * (10000n - feeBps)) / 10000n);
    poolAt = Date.now();
    rate = ((Number(drawer[1]) * Number(apy) * Number(speed)) / (10000 * YEAR)) * keep;

    const { draws } = await loadDraws(15);
    const key = draws.map((x) => `${x.id}:${x.d.awarded}`).join(",") + (state.address || "");
    if (key !== lastKey || force) {
      lastKey = key;
      renderLatest(draws);
      renderHistory(draws);
    }
    tick();
  } catch (e) {
    console.error(e);
  }
}

function renderLatest(draws) {
  const x = latestWithWinners(draws);
  if (!x) {
    $("wKicker").textContent = "No winners yet";
    $("wSub").textContent = "The first draw happens when the countdown below ends.";
    $("wPodium").innerHTML = "";
    return;
  }
  const people = groupWinners(x.winners, x.amounts).length;
  $("wKicker").textContent = `Draw #${x.id}, ${drawWhen(x)}`;
  $("wSub").innerHTML = `<b>${fmt(drawTotal(x))}</b> given away to ${people} saver${people === 1 ? "" : "s"}, out of ${x.entrants} who entered. Nobody lost a cent of their deposit.`;
  const mine = myWin(x, state.address);
  $("wBanner").hidden = mine === 0n;
  $("wBanner").textContent = mine > 0n ? `That's you! You won ${fmt(mine)}.` : "";
  $("wPodium").innerHTML = podiumHTML(x, state.address);
}

function renderHistory(draws) {
  const latest = latestWithWinners(draws);
  const rest = draws.filter((x) => x !== latest);
  if (!rest.length) return ($("wHistory").innerHTML = `<p class="sub">Past draws will show up here.</p>`);
  $("wHistory").innerHTML = rest
    .map((x) => {
      if (!x.d.awarded) return row(x, `<span class="badge wait">Picking winners…</span>`, "");
      if (!x.winners.length) return row(x, `<span class="tiny">No prize this round</span>`, "");
      const g = groupWinners(x.winners, x.amounts);
      const top = g[0];
      const summary = `${avatar(top.addr)}<span><b>${saverName(top.addr, state.address)}</b> won ${fmt(top.amount)}${g.length > 1 ? ` <span class="tiny">+ ${g.length - 1} more</span>` : ""}</span>`;
      const list = g
        .map((w, i) => `<div class="rest-row${state.address && w.addr.toLowerCase() === state.address.toLowerCase() ? " me" : ""}"><span class="rest-n">${i + 1}</span>${avatar(w.addr)}<span class="rest-name">${saverName(w.addr, state.address)}${w.count > 1 ? ` <span class="tiny">${w.count} prizes</span>` : ""}</span><b>${fmt(w.amount)}</b></div>`)
        .join("");
      return row(x, summary, `<div class="pod-rest">${list}</div>`);
    })
    .join("");
}

function row(x, summary, detail) {
  const head = `<span class="h-id">#${x.id}</span><span class="h-sum">${summary}</span><span class="h-amt">${x.winners.length ? fmt(drawTotal(x)) : ""}</span>`;
  return detail
    ? `<details class="h-row"><summary>${head}</summary>${detail}<p class="tiny">${drawWhen(x)}. ${x.entrants} saver${x.entrants === 1n ? "" : "s"} entered.</p></details>`
    : `<div class="h-row plain"><div class="h-line">${head}</div></div>`;
}

function tick() {
  if (!nextDraw) return;
  let s = Math.floor(Number(nextDraw) - (Date.now() / 1000 + chainOffset));
  $("wPool").textContent = "$" + (Math.max(0, pool + rate * ((Date.now() - poolAt) / 1000)) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (s <= 0) return ($("wCount").textContent = "Any moment");
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  const pad = (v) => String(v).padStart(2, "0");
  $("wCount").textContent = d ? `${d}d ${pad(h)}h ${pad(m)}m` : `${h ? h + ":" + pad(m) : m}:${pad(s % 60)}`;
}

main().catch((e) => {
  console.error(e);
  toast("Couldn't load the winners.", true, 0);
});
