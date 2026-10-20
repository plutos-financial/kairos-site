// Kairos saver app: email sign-in, one-tap deposit / withdraw, live prize pool, odds boosts and draws.
// Savers never see exact odds. They see entries (1 per $1) and boosts ("deposit $X, 2x your odds").
import { parseUnits, formatUnits, parseEventLogs, maxUint256 } from "viem";
import abis from "./abis.json";
import {
  $, state, fmt, short, sleep, setup, read, act, friendlyError, toast, txLink,
  emailAvailable, resumeEmailSession, startEmailSignIn, finishEmailSignIn,
  connectBrowserWallet, connectDevKey, signOutAll, canRunDraws, isBeta,
} from "./core.js";
import { podiumHTML, saverName, groupWinners } from "./winners-ui.js";
import { openPretend } from "./pretend.js";

const YEAR = 365 * 24 * 3600;
let tab = "deposit";
let flowId = null;
let pendingEmail = "";
let busy = false;

// latest on-chain snapshot
const s = {
  savings: 0n, wallet: 0n, minDeposit: 1_000_000n, nextDraw: 0n, periodStart: 0n, period: 0n, chainOffset: 0,
  pool: 0n, poolAt: 0, ratePerSec: 0, // ratePerSec in USDC base units (float)
};
const drawCache = new Map(); // finished draws never change, so keep them

// ------------------------------------------------------------------ start

async function main() {
  const ok = await setup();
  if (!ok) {
    toast(
      isBeta
        ? `The beta isn't set up yet. <a href="./deploy.html">Set it up</a> with one MetaMask transaction.`
        : `This site isn't connected to contracts yet. <a href="./deploy.html">Set them up</a>.`,
      true,
      0
    );
    return;
  }
  wireSignIn();
  wireDash();

  if (connectDevKey()) return showDash();
  // Show the sign-in screen right away; quietly restore a previous email session if there is one.
  showSignIn();
  const restored = await Promise.race([resumeEmailSession(), sleep(8000).then(() => false)]);
  if (restored && state.address) showDash();
}

function showSignIn() {
  $("dash").hidden = true;
  $("signin").hidden = false;
  $("who").hidden = true;
  $("signout").hidden = true;
  const emailOn = emailAvailable() || new URLSearchParams(location.search).has("mock");
  $("emailForm").hidden = !emailOn;
  $("emailOff").hidden = emailOn;
  document.querySelector(".or").hidden = !emailOn;
  if (!emailOn) $("useWallet").className = "btn btn-primary btn-lg btn-block";
}

let beta = null; // the beta wallet module, loaded only in the beta
async function startBeta() {
  if (!isBeta || beta) return;
  beta = await import("./beta-wallet.js");
  beta.initBetaWallet({
    wallet: () => s.wallet,
    savings: () => s.savings,
    refresh,
    fillDeposit(amount) {
      setTab("deposit");
      $("amount").value = formatUnits(amount, 6);
      updatePreview();
      $("amount").focus();
      if (innerWidth < 1000) document.querySelector(".ticket").scrollIntoView({ behavior: "smooth", block: "center" });
    },
  });
}

let started = false;
async function showDash() {
  await startBeta();
  $("signin").hidden = true;
  $("dash").hidden = false;
  $("who").hidden = false;
  $("signout").hidden = false;
  $("who").textContent = state.email || short(state.address);
  $("who").className = "pill ok";
  $("acct").innerHTML = state.explorer
    ? `<a href="${state.explorer}/address/${state.address}" target="_blank" rel="noopener">Account ${short(state.address)}</a>`
    : `Account ${short(state.address)}`;
  await refresh();
  showTeamControls();
  if (started) return;
  started = true;
  setInterval(refresh, 6000);
  setInterval(tick, 1000);
}

// The Kairos team sees a shortcut to the real draw controls instead of the pretend draw.
async function showTeamControls() {
  try {
    if (!(await canRunDraws(await read("vault", "owner")))) return;
    $("pvTitle").textContent = "You run the draws";
    $("pvText").textContent = "Pick the winners, skip a countdown, or change how often draws happen.";
    $("pretendBtn").hidden = true;
    $("drawLink").hidden = false;
    $("drawsTop").hidden = false;
  } catch (e) {
    console.warn(e);
  }
}

// ------------------------------------------------------------------ sign in

function wireSignIn() {
  const err = (m) => ($("signinError").textContent = m || "");

  $("emailForm").onsubmit = async (e) => {
    e.preventDefault();
    err("");
    const email = $("email").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.");
    setBusy($("sendCode"), "Sending…");
    try {
      flowId = await startEmailSignIn(email);
      pendingEmail = email;
      $("sentTo").textContent = email;
      $("emailForm").hidden = true;
      $("codeForm").hidden = false;
      $("code").focus();
    } catch (x) {
      console.error(x);
      err(signInProblem(x));
    } finally {
      clearBusy($("sendCode"), "Continue");
    }
  };

  $("codeForm").onsubmit = async (e) => {
    e.preventDefault();
    err("");
    const otp = $("code").value.replace(/\D/g, "");
    if (otp.length !== 6) return err("Enter the 6-digit code from your email.");
    setBusy($("verify"), "Signing in…");
    try {
      await finishEmailSignIn(flowId, otp, pendingEmail);
      await showDash();
      toast("You're in. Grab some test dollars to start.");
    } catch (x) {
      console.error(x);
      err(/otp|code|invalid|expired/i.test(x?.message || "") ? "That code didn't work. Check it or request a new one." : signInProblem(x));
    } finally {
      clearBusy($("verify"), "Continue");
    }
  };
  $("code").oninput = () => {
    if ($("code").value.replace(/\D/g, "").length === 6) $("codeForm").requestSubmit();
  };

  $("backToEmail").onclick = () => {
    $("codeForm").hidden = true;
    $("emailForm").hidden = false;
    err("");
  };

  $("useWallet").onclick = async () => {
    err("");
    try {
      await connectBrowserWallet();
      await showDash();
    } catch (x) {
      err(friendlyError(x));
    }
  };

  $("signout").onclick = async () => {
    await signOutAll();
    location.reload();
  };
}

function signInProblem(x) {
  const m = x?.message || "";
  if (/domain|origin|cors|not allowed|forbidden|403/i.test(m))
    return "This website isn't on the allowed list in the Coinbase developer portal yet (Embedded Wallets → Domains).";
  if (/network|fetch/i.test(m)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  return m || "Something went wrong. Try again.";
}

// ------------------------------------------------------------------ deposit / withdraw

function setTab(name) {
  tab = name;
  document.querySelectorAll(".tab").forEach((x) => {
    x.classList.toggle("active", x.dataset.tab === name);
    x.setAttribute("aria-selected", x.dataset.tab === name);
  });
  $("go").textContent = name === "deposit" ? "Deposit" : "Withdraw";
  updateHint();
  updatePreview();
}

function wireDash() {
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
  document.querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => {
      const v = c.dataset.v;
      $("amount").value = v === "max" ? formatUnits(tab === "deposit" ? s.wallet : s.savings, 6) : v;
      updatePreview();
    };
  });
  $("amount").addEventListener("input", updatePreview);
  $("boosts").addEventListener("click", (e) => {
    const b = e.target.closest(".boost-tile");
    if (!b) return;
    setTab("deposit");
    $("amount").value = b.dataset.fill;
    updatePreview();
    $("amount").focus();
    if (innerWidth < 1000) document.querySelector(".ticket").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("pretendBtn").onclick = () => openPretend();
  $("faucet").onclick = (e) => doFaucet(e.currentTarget);
  $("faucet2").onclick = (e) => doFaucet(e.currentTarget);
  $("go").onclick = () => (tab === "deposit" ? doDeposit() : doWithdraw());
  $("winKeep").onclick = closeWinner;
  $("winWithdraw").onclick = () => {
    closeWinner();
    setTab("withdraw");
    $("amount").value = formatUnits(s.savings, 6);
    updatePreview();
    $("amount").focus();
  };
  addEventListener("keydown", (e) => e.key === "Escape" && closeWinner());
}

async function doFaucet(btn) {
  if (busy) return;
  const last = await read("usdc", "lastFaucet", [state.address]);
  const now = BigInt(Math.floor(Date.now() / 1000) + s.chainOffset);
  if (last > 0n && now < last + 3600n) {
    const mins = Math.ceil(Number(last + 3600n - now) / 60);
    return toast(`You already got test dollars this hour. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`, true);
  }
  await run(btn, "Get $1,000", [{ c: "usdc", fn: "faucet" }], () => "Added $1,000 test dollars.");
}

async function doDeposit() {
  const amt = amountInput();
  if (amt === null) return;
  if (amt < s.minDeposit) return toast(`The minimum deposit is ${fmt(s.minDeposit, 0)}.`, true);
  if (amt > s.wallet) return toast(isBeta ? `You have ${fmt(s.wallet)} in your Kairos wallet. Tap Add money first.` : `You have ${fmt(s.wallet)} in test dollars. Get more first.`, true);
  const calls = [];
  const allowance = await read("usdc", "allowance", [state.address, state.cfg.vault]);
  // Email accounts approve the exact amount inside the same one-tap action.
  // Browser wallets approve once, so later deposits need only one pop-up.
  if (allowance < amt) calls.push({ c: "usdc", fn: "approve", args: [state.cfg.vault, state.mode === "email" ? amt : maxUint256] });
  calls.push({ c: "vault", fn: "deposit", args: [amt] });
  await run($("go"), "Deposit", calls, () => `Deposited ${fmt(amt, 0)}. That's ${dollars(amt).toLocaleString()} more ${dollars(amt) === 1 ? "entry" : "entries"}.`);
}

async function doWithdraw() {
  const amt = amountInput();
  if (amt === null) return;
  if (amt > s.savings) return toast(`You have ${fmt(s.savings)} in savings.`, true);
  await run($("go"), "Withdraw", [{ c: "vault", fn: "withdraw", args: [amt] }], async (hash) => {
    try {
      const r = await state.pub.getTransactionReceipt({ hash });
      const q = parseEventLogs({ abi: abis.KairosVault, logs: r.logs, eventName: "WithdrawalQueued" })[0];
      if (q) return `Your ${fmt(amt, 0)} is in line (#${q.args.position}). The cash drawer is low, so it arrives as soon as T-bills settle, about 2 minutes in this demo.`;
    } catch {}
    return isBeta ? `Withdrew ${fmt(amt, 0)} to your Kairos wallet.` : `Withdrew ${fmt(amt, 0)} back to your test dollars.`;
  });
}

function amountInput() {
  const raw = String($("amount").value || "").trim();
  if (!raw || Number(raw) <= 0) {
    toast("Enter an amount.", true);
    return null;
  }
  try {
    return parseUnits(raw, 6);
  } catch {
    toast("Enter a valid amount.", true);
    return null;
  }
}

async function run(btn, label, calls, successMsg) {
  if (busy) return;
  busy = true;
  setBusy(btn, label === "Deposit" || label === "Withdraw" ? "Working…" : "…");
  try {
    const hash = await act(calls, (m) => setBusy(btn, m));
    await refresh();
    const msg = typeof successMsg === "function" ? await successMsg(hash) : successMsg;
    toast(`${msg} ${txLink(hash)}`, false, 8000);
  } catch (x) {
    console.error(x);
    toast(friendlyError(x), true);
  } finally {
    busy = false;
    clearBusy(btn, btn === $("go") ? (tab === "deposit" ? "Deposit" : "Withdraw") : btn.dataset.label || label);
  }
}

function setBusy(btn, text) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> <span class="status">${text}</span>`;
}
function clearBusy(btn, text) {
  btn.disabled = false;
  btn.textContent = text;
}

// ------------------------------------------------------------------ odds as entries and boosts

const dollars = (x) => Math.floor(Number(formatUnits(x, 6)));
const money = (n) => "$" + Math.ceil(n).toLocaleString("en-US");
function times(x) {
  if (!isFinite(x)) return "—";
  const v = x >= 10 ? Math.round(x).toLocaleString("en-US") : String(Number(x.toFixed(1)));
  return v + "×";
}

function renderBoosts() {
  const bal = Number(formatUnits(s.savings, 6));
  let tiles;
  if (bal < 1) {
    tiles = [10, 100, 1000].map((n) => ({ big: n.toLocaleString("en-US"), label: "entries", cta: `Deposit ${money(n)}`, fill: n }));
  } else {
    tiles = [1.5, 2, 5].map((m) => {
      const add = Math.max(1, Math.ceil(bal * (m - 1)));
      return { big: times(m), label: "your odds", cta: `Add ${money(add)}`, fill: add };
    });
  }
  const html = tiles
    .map((t) => `<button type="button" class="boost-tile" data-fill="${t.fill}"><span class="bx">${t.big}</span><span class="bl">${t.label}</span><span class="ba">${t.cta}</span></button>`)
    .join("");
  if ($("boosts").innerHTML !== html) $("boosts").innerHTML = html;
}

function updatePreview() {
  const el = $("boostPreview");
  const v = Number($("amount").value);
  $("amount").style.width = Math.max(1.5, String($("amount").value || "").length + 0.4) + "ch";
  const bal = Number(formatUnits(s.savings, 6));
  if (!v || v <= 0) return (el.innerHTML = "&nbsp;");
  if (tab === "deposit") {
    el.textContent = bal >= 1 ? `${times((bal + v) / bal)} your odds` : `${Math.floor(v).toLocaleString("en-US")} entries in every draw`;
  } else {
    const left = Math.max(0, bal - v);
    el.textContent = left >= 1 ? `Leaves ${Math.floor(left).toLocaleString("en-US")} entries` : "Leaves you out of the next draw";
  }
}

// ------------------------------------------------------------------ reading state

async function refresh() {
  if (!state.address) return;
  try {
    const block = await state.pub.getBlock();
    s.chainOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
    const [bal, wal, odds, drawer, reserve, interest, nd, ps, per, curId, splits, feeBps, apy, speed] = await Promise.all([
      read("vault", "balanceOf", [state.address]),
      read("usdc", "balanceOf", [state.address]),
      read("vault", "projectedOdds", [state.address]),
      read("vault", "drawerState"),
      read("vault", "prizeReserve"),
      read("vault", "availableInterest"),
      read("vault", "nextDrawTime"),
      read("vault", "periodStart"),
      read("vault", "drawPeriod"),
      read("vault", "currentDrawId"),
      read("vault", "prizeSplits"),
      read("vault", "feeBps"),
      read("tbill", "apyBps"),
      read("tbill", "speed"),
    ]);
    s.minDeposit = await read("vault", "minDeposit").catch(() => s.minDeposit);
    Object.assign(s, { savings: bal, wallet: wal, nextDraw: nd, periodStart: ps, period: per });
    const keep = Number(10000n - feeBps) / 10000;
    s.pool = reserve + (interest * (10000n - feeBps)) / 10000n;
    s.poolAt = Date.now();
    s.ratePerSec = (Number(drawer[1]) * Number(apy) * Number(speed)) / (10000 * YEAR) * keep;

    $("savings").textContent = fmt(bal);
    $("getDollars").hidden = isBeta || wal > 0n || bal > 0n;
    $("faucetMore").hidden = isBeta || !$("getDollars").hidden;
    beta?.renderWallet(wal, bal);
    $("winnersN").textContent = splits.length.toLocaleString();
    $("splits").textContent = `${splits.length} winner${splits.length === 1 ? "" : "s"} split it`;

    // Entries: one per dollar. Time matters (balance x time), so someone who joins mid-round
    // only gets part of their entries in this draw. No exact odds are shown.
    const full = dollars(bal);
    $("entries").textContent = full.toLocaleString("en-US");
    const nowChain = BigInt(Math.floor(Date.now() / 1000) + s.chainOffset);
    const span = nowChain > ps + per ? nowChain - ps : per;
    const thisRound = span > 0n ? Math.floor(Number(odds[0] / span) / 1e6) : 0;
    const note = $("entriesNote");
    if (full > 0 && thisRound < full - 1) {
      note.hidden = false;
      note.textContent = `You joined partway through this round, so ${thisRound.toLocaleString("en-US")} of your entries count in this draw. All ${full.toLocaleString("en-US")} count in the next one.`;
    } else note.hidden = true;

    renderBoosts();
    updateHint();
    updatePreview();
    await renderDraws(curId);
    tick();
  } catch (e) {
    console.error(e);
  }
}

async function getDrawCached(id) {
  if (drawCache.has(id)) return drawCache.get(id);
  const row = await read("vault", "getDraw", [id]);
  if (row[0].awarded) drawCache.set(id, row);
  return row;
}

async function renderDraws(curId) {
  const ids = [];
  for (let id = curId - 1n; id >= 1n && ids.length < 20; id--) ids.push(id);
  if (!ids.length) {
    $("draws").innerHTML = `<p class="sub">No draws yet. The first one happens when the countdown ends.</p>`;
    $("latestCard").hidden = true;
    setWon(0n);
    return;
  }
  const rows = await Promise.all(ids.map(getDrawCached));
  const me = state.address.toLowerCase();
  checkForWins(ids, rows, me);
  renderLatest(ids, rows, me);

  let wonTotal = 0n;
  const html = rows.map(([d, winners, amounts, entrants], i) => {
    let mine = 0n;
    winners.forEach((w, j) => w.toLowerCase() === me && (mine += amounts[j]));
    wonTotal += mine;
    if (i >= 6) return "";
    const when = new Date(Number(d.closeTime) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    let body;
    if (d.prize === 0n) body = `<div class="winners">No prize this round</div>`;
    else if (!d.awarded || !winners.length) body = `<div class="winners"><span class="badge wait">Picking winners…</span></div>`;
    else {
      // group by winner so a saver who won 3 prizes shows once
      const list = groupWinners(winners, amounts);
      const shown = list.slice(0, 4).map((w) => (w.addr.toLowerCase() === me ? `<span class="me">You won ${fmt(w.amount)}</span>` : `<span>${saverName(w.addr)} won ${fmt(w.amount)}</span>`));
      if (list.length > 4) shown.push(`<span>+${list.length - 4} more</span>`);
      body = `<div class="winners">${shown.join("")}</div>`;
    }
    return `<div class="draw${mine > 0n ? " mine" : ""}">
      <div class="d-ico">#${ids[i]}</div>
      <div><div class="d-title">Draw #${ids[i]}<span class="tiny">${when}</span></div>${body}</div>
      <div class="d-amt">${mine > 0n ? "+" + fmt(mine) : fmt(d.prize)}</div>
    </div>`;
  }).join("");
  $("draws").innerHTML = html;
  setWon(wonTotal);
}

// The newest draw with winners, as a podium near the top of the page.
function renderLatest(ids, rows, me) {
  const i = rows.findIndex(([d, winners]) => d.awarded && winners.length);
  const card = $("latestCard");
  if (i < 0) return (card.hidden = true);
  const [d, winners, amounts, entrants] = rows[i];
  const x = { id: ids[i], d, winners, amounts, entrants };
  let mine = 0n;
  winners.forEach((w, j) => w.toLowerCase() === me && (mine += amounts[j]));
  const total = amounts.reduce((a, b) => a + b, 0n);
  const key = `${ids[i]}:${mine}`;
  card.hidden = false;
  if (card.dataset.key === key) return; // nothing new
  card.dataset.key = key;
  $("latestTitle").textContent = `Draw #${ids[i]} winners`;
  $("latestBanner").hidden = mine === 0n;
  $("latestBanner").textContent = mine > 0n ? `You won ${fmt(mine)} in this draw. It's already in your savings.` : "";
  $("latestPodium").innerHTML = podiumHTML(x, state.address);
  const when = new Date(Number(d.closeTime) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  $("latestMeta").textContent = `${fmt(total)} given away on ${when}. ${entrants} saver${entrants === 1n ? "" : "s"} entered.`;
}

function setWon(total) {
  const el = $("wonLine");
  if (total > 0n) {
    el.textContent = `▲ ${fmt(total)} won in prizes`;
    el.className = "won-line up";
  } else {
    el.textContent = s.savings > 0n ? "Your deposit is always yours. Withdraw anytime." : "Every $1 you save is an entry in every draw.";
    el.className = "won-line";
  }
}

// ------------------------------------------------------------------ live pool, countdown, chart

function tick() {
  if (!s.periodStart) return;
  const nowSec = Date.now() / 1000 + s.chainOffset;
  const poolNow = Number(s.pool) + s.ratePerSec * ((Date.now() - s.poolAt) / 1000);
  const end = Number(s.nextDraw);
  $("pool").textContent = fmtFloat(poolNow);

  let left = Math.floor(end - nowSec);
  if (!$("drawLink").hidden) $("drawLink").textContent = left <= 0 ? "Pick winners now" : "Open draw controls";
  if (left <= 0) {
    $("countdown").textContent = "Drawing soon";
    $("poolProj").textContent = fmtFloat(poolNow);
  } else {
    $("poolProj").textContent = "~" + fmtFloat(poolNow + s.ratePerSec * left);
    const d = Math.floor(left / 86400);
    left %= 86400;
    const h = Math.floor(left / 3600);
    left %= 3600;
    const m = Math.floor(left / 60);
    const pad = (x) => String(x).padStart(2, "0");
    $("countdown").textContent = d ? `${d}d ${pad(h)}h` : `${h ? pad(h) + ":" : ""}${pad(m)}:${pad(left % 60)}`;
  }
  drawChart(Number(s.periodStart), nowSec, Math.max(end, nowSec), poolNow);
}

const fmtFloat = (base) => "$" + (Math.max(0, base) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The pool grows steadily with T-bill interest: solid line so far this round, dashed to the draw.
function drawChart(t0, now, t1, poolNow) {
  const W = 600, top = 14, bottom = 136, right = 592; // keep the end marker inside the chart
  const span = Math.max(1, t1 - t0);
  const poolEnd = poolNow + s.ratePerSec * Math.max(0, t1 - now);
  const max = Math.max(poolEnd, 1) * 1.08;
  const X = (t) => ((t - t0) / span) * right;
  const Y = (v) => bottom - (Math.max(0, v) / max) * (bottom - top);
  const poolAt = (t) => Math.max(0, poolNow - s.ratePerSec * (now - t));
  const pts = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((now - t0) * i) / n;
    pts.push(`${X(t).toFixed(1)},${Y(poolAt(t)).toFixed(1)}`);
  }
  const head = [X(now), Y(poolNow)];
  const future = now < t1 ? `<path d="M${head[0].toFixed(1)} ${head[1].toFixed(1)} L${right} ${Y(poolEnd).toFixed(1)}" stroke="#f4c24f" stroke-opacity="0.45" stroke-width="2" stroke-dasharray="3 6" fill="none" vector-effect="non-scaling-stroke"/>
      <circle cx="${right}" cy="${Y(poolEnd).toFixed(1)}" r="4" fill="#050506" stroke="#f4c24f" stroke-opacity="0.6" stroke-width="2" vector-effect="non-scaling-stroke"/>` : "";
  $("poolChart").innerHTML = `
    <line x1="0" y1="${bottom}" x2="${W}" y2="${bottom}" stroke="#ffffff" stroke-opacity="0.08" stroke-dasharray="2 5" vector-effect="non-scaling-stroke"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="#f4c24f" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    ${future}
    <circle cx="${head[0].toFixed(1)}" cy="${head[1].toFixed(1)}" r="9" fill="#f4c24f" opacity="0.18"><animate attributeName="r" values="6;12;6" dur="1.6s" repeatCount="indefinite"/></circle>
    <circle cx="${head[0].toFixed(1)}" cy="${head[1].toFixed(1)}" r="4.5" fill="#f4c24f"/>`;
  $("roundStart").textContent = "Round started " + new Date((t0 - s.chainOffset) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ------------------------------------------------------------------ winner celebration

function seenKey() {
  return `kairos.celebrated.${state.cfg.vault}.${state.address}`.toLowerCase();
}
function checkForWins(ids, rows, me) {
  let seen = [];
  try {
    seen = JSON.parse(localStorage.getItem(seenKey()) || "[]");
  } catch {}
  // only celebrate the newest few draws, oldest first
  for (let i = Math.min(rows.length, 5) - 1; i >= 0; i--) {
    const [d, winners, amounts] = rows[i];
    const id = Number(ids[i]);
    if (!d.awarded || seen.includes(id)) continue;
    let total = 0n;
    winners.forEach((w, j) => {
      if (w.toLowerCase() === me) total += amounts[j];
    });
    if (total > 0n) {
      seen.push(id);
      try {
        localStorage.setItem(seenKey(), JSON.stringify(seen.slice(-50)));
      } catch {}
      celebrate(id, total);
      return; // one celebration at a time
    }
  }
}

function celebrate(drawId, amount) {
  if (!$("winner").hidden) return;
  $("winDraw").textContent = drawId;
  $("winAmount").textContent = fmt(amount);
  $("winSavings").textContent = fmt(s.savings);
  $("winner").hidden = false;
  $("winKeep").focus();
  confetti();
}

function closeWinner() {
  $("winner").hidden = true;
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = $("confetti");
  const ctx = c.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr;
  c.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ["#f4c24f", "#ffd77a", "#fffcf7", "#f5c542", "#f4c24f"];
  const bits = Array.from({ length: 170 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 140,
    y: innerHeight * 0.38,
    vx: (Math.random() - 0.5) * 15,
    vy: -Math.random() * 15 - 4,
    r: 4 + Math.random() * 6,
    a: Math.random() * Math.PI,
    va: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.32;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.a += b.va;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2);
      ctx.restore();
    }
    if (t - start < 4500 && !$("winner").hidden) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  }
  requestAnimationFrame(frame);
}

function updateHint() {
  $("hint").innerHTML =
    tab === "deposit"
      ? isBeta
        ? `From your Kairos wallet: <span>${fmt(s.wallet)}</span>`
        : `Test dollars available: <span>${fmt(s.wallet)}</span>`
      : `In savings: <span>${fmt(s.savings)}</span>. Always yours to take out.`;
}

main().catch((e) => {
  console.error(e);
  toast("Something went wrong loading Kairos. Refresh the page.", true, 0);
});
