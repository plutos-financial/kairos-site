// The phone on the homepage: a tappable preview of the app with sample numbers.
// Tabs work, the countdown ticks, the prize pool grows, Add money and Withdraw move money
// between "saved" (in the draw) and "cash" (not in it), and a pretend draw can be watched.
const $ = (id) => document.getElementById(id);
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (n) => "$" + Math.round(n).toLocaleString("en-US");

// Sample saver: dollars kept in for different lengths of time (newest last).
const lots = [
  { amt: 500, x: 3 },
  { amt: 500, x: 2 },
  { amt: 250, x: 1 },
];
let cash = 0;
let won = 250;
let shownBal = 0;

const saved = () => lots.reduce((a, l) => a + l.amt, 0);
const entries = () => lots.reduce((a, l) => a + l.amt * l.x, 0);
const TIER = { 3: "Kept a year: 3x", 2: "Kept 6 months: 2x", 1.5: "Kept 3 months: 1.5x", 1: "New: 1x" };

function paintBal(n) {
  const [d, c] = usd(n).split(".");
  $("pBal").innerHTML = `${d}<span>.${c}</span>`;
}

function countTo(target) {
  const from = shownBal;
  shownBal = target;
  if (calm || from === target) return paintBal(target);
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / 700);
    paintBal(from + (target - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function render() {
  const s = saved();
  const e = entries();
  countTo(s);
  $("pWon").textContent = "+" + usd(won);
  $("pEntries").textContent = e.toLocaleString("en-US");
  $("pBoost").textContent = `${s > 0 ? Number((e / s).toFixed(1)) : 1}× boost`;
  $("pSaved").textContent = usd(s);
  $("pCash").textContent = usd(cash);
  const byTier = {};
  for (const l of lots) byTier[l.x] = (byTier[l.x] || 0) + l.amt;
  const max = Math.max(1, ...Object.values(byTier));
  $("pTiers").innerHTML = [3, 2, 1.5, 1]
    .filter((x) => byTier[x])
    .map((x) => `<div class="at-row"><span>${TIER[x]}</span><b>${whole(byTier[x])}</b><i style="width:${(byTier[x] / max) * 100}%"></i></div>`)
    .join("") || `<p class="a-tiny">Nothing saved right now.</p>`;
}

let toastTimer;
function toast(text) {
  const t = $("pToast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ------------------------------------------------------------------ tabs

function showTab(name) {
  document.querySelectorAll(".tabbar [role=tab]").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".app .pane").forEach((p) => (p.hidden = p.id !== `pane-${name}`));
  closeSheet();
}

// ------------------------------------------------------------------ add money / withdraw

let mode = "add";
let amount = 100;
function openSheet(m) {
  mode = m;
  $("pSheetTitle").textContent = m === "add" ? "Add money" : "Withdraw";
  setAmount(m === "out" ? Math.min(100, saved()) || 0 : 100);
  $("pSheet").hidden = false;
  $("pSheetGo").focus();
}
function closeSheet() {
  $("pSheet").hidden = true;
}
function setAmount(v) {
  amount = v;
  $("pSheetAmt").textContent = whole(v);
  $("pSheetGo").textContent = mode === "add" ? `Save ${whole(v)}` : `Withdraw ${whole(v)}`;
  $("pSheetGo").disabled = v <= 0;
  document.querySelectorAll("#pChips button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === v));
}
function confirmSheet() {
  if (mode === "add") {
    lots.push({ amt: amount, x: 1 });
    toast(`Saved ${whole(amount)}. It's in the draw.`);
  } else {
    let left = Math.min(amount, saved());
    const out = left;
    while (left > 0 && lots.length) {
      const l = lots[lots.length - 1]; // newest dollars first
      const take = Math.min(l.amt, left);
      l.amt -= take;
      left -= take;
      if (l.amt === 0) lots.pop();
    }
    cash += out;
    toast(`${whole(out)} moved to cash. It's out of the draw.`);
  }
  closeSheet();
  render();
}

// ------------------------------------------------------------------ live countdown and prize pool

function live() {
  const end = Date.now() + ((2 * 24 + 14) * 3600 + 37 * 60 + 12) * 1000;
  const start = Date.now();
  const tick = () => {
    const left = Math.max(0, Math.floor((end - Date.now()) / 1000));
    const d = Math.floor(left / 86400);
    const h = Math.floor((left % 86400) / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    const text = `${d}d ${h}h ${m}m ${String(s).padStart(2, "0")}s`;
    $("pCount").textContent = text;
    $("pCount2").textContent = text;
    const pool = usd(48210 + ((Date.now() - start) / 1000) * 0.07); // the interest arriving
    $("pPool").textContent = pool;
    $("pPool2").textContent = pool;
    $("pRound").style.width = `${68 + ((Date.now() - start) / 1000) * 0.0005}%`;
  };
  tick();
  setInterval(tick, 250);
}

// ------------------------------------------------------------------ chart ranges

const RANGES = {
  "1W": [60, 60, 59, 59, 58, 58, 57, 57, 56],
  "1M": [64, 62, 61, 58, 57, 55, 54, 50, 48],
  "3M": [62, 60, 54, 53, 47, 46, 30, 16, 14],
  "1Y": [70, 66, 60, 52, 44, 38, 30, 20, 14],
  All: [72, 70, 64, 58, 48, 40, 32, 22, 12],
};
function chart(key) {
  const ys = RANGES[key];
  const pts = ys.map((y, i) => `${((i / (ys.length - 1)) * 244).toFixed(1)} ${y}`);
  const line = "M" + pts.join(" L");
  $("pLine").setAttribute("d", line);
  $("pFill").setAttribute("d", `${line} V74 H0 Z`);
  document.querySelectorAll("#pRange button").forEach((b) => {
    const on = b.textContent === key;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

// ------------------------------------------------------------------ a pretend draw

const SEG = [9, 5, 6, 12, 4, 8, 3]; // stretches of the line; index 2 is you
const NAMES = ["Saver 4F2A", "Saver 91C0", "You", "Saver 07DE", "Saver B3A9", "Saver 5E1C", "Saver D84F"];
let drawing = false;
function pretendDraw() {
  if (drawing) return;
  drawing = true;
  $("pDrawGo").disabled = true;
  $("pResult").textContent = "Chainlink is picking a spot…";
  document.querySelectorAll("#pLineTrack i").forEach((i) => i.classList.remove("hit"));
  const total = SEG.reduce((a, b) => a + b, 0);
  const youWin = Math.random() < 0.35;
  let idx = youWin ? 2 : [0, 1, 3, 4, 5, 6][Math.floor(Math.random() * 6)];
  const before = SEG.slice(0, idx).reduce((a, b) => a + b, 0);
  const spot = ((before + SEG[idx] * (0.2 + Math.random() * 0.6)) / total) * 100;
  const pin = $("pPin");
  const land = () => {
    pin.style.left = `${spot}%`;
    $("pLineTrack").children[idx].classList.add("hit");
    const prize = youWin ? 250 : 1000;
    if (youWin) {
      lots.push({ amt: prize, x: 1 }); // prizes go straight into savings
      won += prize;
      render();
      $("pResult").innerHTML = `It landed in your stretch. <b>You won ${whole(prize)}</b>, straight into your savings.`;
      $("pNotifMsg").innerHTML = `You won <b class="gold">${usd(prize)}</b> in a pretend draw.`;
      const n = $("pNotif");
      n.style.animation = "none";
      void n.offsetWidth;
      n.style.animation = "";
    } else {
      $("pResult").textContent = `It landed on ${NAMES[idx]}, who wins ${whole(prize)}. Your savings stay exactly where they are.`;
    }
    $("pDrawGo").textContent = "Watch another";
    $("pDrawGo").disabled = false;
    drawing = false;
  };
  if (calm) return land();
  // sweep once round the line, then slow down onto the spot, like a wheel
  const dist = 100 + spot;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / 2200);
    pin.style.left = `${(dist * (1 - Math.pow(1 - p, 3))) % 100}%`;
    if (p < 1) requestAnimationFrame(step);
    else land();
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ wiring

export function phone() {
  if (!$("pBal")) return;
  const tabs = [...document.querySelectorAll(".tabbar [role=tab]")];
  tabs.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.querySelector(".tabbar").addEventListener("keydown", (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0 || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const next = tabs[(i + (e.key === "ArrowLeft" ? tabs.length - 1 : 1)) % tabs.length];
    next.focus();
    next.click();
  });
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openSheet(b.dataset.open)));
  $("pChips").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setAmount(mode === "out" ? Math.min(Number(b.dataset.v), saved()) : Number(b.dataset.v));
  });
  $("pSheetGo").addEventListener("click", confirmSheet);
  $("pSheetX").addEventListener("click", closeSheet);
  $("pRange").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) chart(b.textContent);
  });
  $("pDrawGo").addEventListener("click", pretendDraw);
  chart("3M");
  shownBal = saved();
  render();
  live();
}
