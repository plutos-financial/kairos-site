// Plutos savings page: email sign-in, the wallet, save / withdraw, and the next draw.
// Savers never see exact odds. They see entries (1 per $1) and how much a deposit multiplies them.
import { parseUnits, formatUnits, parseEventLogs, maxUint256 } from "viem";
import abis from "./abis.json";
import {
  $, state, fmt, sleep, setup, read, act, friendlyError, toast, toastError, txLink,
  emailAvailable, mockSignIn, resumeEmailSession, startEmailSignIn, finishEmailSignIn,
  connectBrowserWallet, connectDevKey, canRunDraws, isBeta,
} from "./core.js";
import { groupWinners } from "./winners-ui.js";
import { showAccount, wireAccount } from "./appbar.js";
import { openPretend } from "./pretend.js";
import { replayDraw } from "./drawshow.js";

const YEAR = 365 * 24 * 3600;
let tab = "deposit";
let flowId = null;
let pendingEmail = "";
let busy = false;
let admin = false;

// latest on-chain snapshot
const s = {
  savings: 0n, wallet: 0n, minDeposit: 1_000_000n, nextDraw: 0n, periodStart: 0n, period: 0n, chainOffset: 0,
  pool: 0n, poolAt: 0, ratePerSec: 0, // ratePerSec in USDC base units (float)
  loaded: false,
};
const drawCache = new Map(); // finished draws never change, so keep them

// ------------------------------------------------------------------ start

async function main() {
  const ok = await setup();
  if (!ok) {
    toast(`Plutos isn't connected to its contracts yet. <a href="./deploy.html">Set them up</a> with one MetaMask transaction.`, true, 0);
    return;
  }
  wireAccount();
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
  showAccount();
  const emailOn = emailAvailable() || mockSignIn();
  $("emailForm").hidden = !emailOn;
  $("emailOff").hidden = emailOn;
  document.querySelector(".or").hidden = !emailOn;
  if (!emailOn) $("useWallet").className = "btn btn-primary btn-lg btn-block";
}

let beta = null; // the wallet module (Add money, send, receive, cash out)
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
      if (innerWidth < 1000) $("ticket").scrollIntoView({ behavior: "smooth", block: "center" });
    },
  });
}

let started = false;
async function showDash() {
  await startBeta();
  $("signin").hidden = true;
  $("dash").hidden = false;
  showAccount();
  await refresh();
  showTeamControls();
  if (started) return;
  started = true;
  setInterval(refresh, 6000);
  setInterval(tick, 1000);
}

// The Plutos team gets a shortcut to the real draw controls.
async function showTeamControls() {
  try {
    admin = await canRunDraws(await read("vault", "owner"));
    showAccount({ admin });
    if (!admin) return;
    $("drawLink").hidden = false;
    tick();
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
    if (!/^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 254) return err("Enter a valid email address.");
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
      toast(isBeta ? "You're in. Start with Add money." : "You're in. Grab some test dollars to start.");
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
}

function signInProblem(x) {
  const m = String(x?.message || "");
  if (/domain|origin|cors|not allowed|forbidden|403/i.test(m))
    return "This website isn't on the allowed list in the Coinbase developer portal yet (Embedded Wallets → Domains).";
  if (/network|fetch/i.test(m)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  if (/rate|too many|429/i.test(m)) return "Too many tries. Wait a minute and try again.";
  return m && m.length < 160 ? m : "Something went wrong signing in. Try again.";
}

// ------------------------------------------------------------------ save / withdraw

const needsMoney = () => isBeta && tab === "deposit" && s.loaded && s.wallet === 0n;

function goLabel() {
  if (needsMoney()) return "Add money first";
  const v = Number($("amount").value);
  const amt = v > 0 && isFinite(v) ? " $" + v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "";
  return (tab === "deposit" ? "Save" : "Withdraw") + amt;
}

function setTab(name) {
  tab = name;
  document.querySelectorAll(".tab").forEach((x) => {
    x.classList.toggle("active", x.dataset.tab === name);
    x.setAttribute("aria-selected", x.dataset.tab === name);
  });
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
  $("pretendBtn").onclick = () => openPretend();
  $("faucet").onclick = (e) => doFaucet(e.currentTarget);
  $("faucet2").onclick = (e) => doFaucet(e.currentTarget);
  $("go").onclick = () => (needsMoney() ? beta?.openAction("add") : tab === "deposit" ? doDeposit() : doWithdraw());
  $("starter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    if (b.dataset.go === "add") return isBeta ? beta?.openAction("add") : doFaucet($("faucet"));
    if (b.dataset.go === "save") {
      setTab("deposit");
      $("amount").focus();
      if (innerWidth < 1000) $("ticket").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    document.querySelector(".next-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("winKeep").onclick = closeWinner;
  $("winHow").onclick = () => {
    closeWinner();
    replayDraw(Number($("winDraw").textContent));
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
  await run(btn, [{ c: "usdc", fn: "faucet" }], () => "Added $1,000 test dollars.");
}

async function doDeposit() {
  const amt = amountInput();
  if (amt === null) return;
  if (amt < s.minDeposit) return toast(`The smallest amount you can save is ${fmt(s.minDeposit, 0)}.`, true);
  if (amt > s.wallet) return toast(isBeta ? `You have ${fmt(s.wallet)} in your Plutos wallet. Add money first.` : `You have ${fmt(s.wallet)} in test dollars. Get more first.`, true);
  const calls = [];
  const allowance = await read("usdc", "allowance", [state.address, state.cfg.vault]);
  // Email accounts approve the exact amount inside the same one-tap action.
  // Browser wallets approve once, so later deposits need only one pop-up.
  if (allowance < amt) calls.push({ c: "usdc", fn: "approve", args: [state.cfg.vault, state.mode === "email" ? amt : maxUint256] });
  calls.push({ c: "vault", fn: "deposit", args: [amt] });
  await run($("go"), calls, () => `Saved ${fmt(amt, 0)}. That's ${dollars(amt).toLocaleString()} more ${dollars(amt) === 1 ? "entry" : "entries"}.`);
}

async function doWithdraw() {
  const amt = amountInput();
  if (amt === null) return;
  if (amt > s.savings) return toast(`You have ${fmt(s.savings)} in savings.`, true);
  await run($("go"), [{ c: "vault", fn: "withdraw", args: [amt] }], async (hash) => {
    try {
      const r = await state.pub.getTransactionReceipt({ hash });
      const q = parseEventLogs({ abi: abis.KairosVault, logs: r.logs, eventName: "WithdrawalQueued" })[0];
      if (q) return `Your ${fmt(amt, 0)} is in line (#${q.args.position}). The cash drawer is low, so it arrives as soon as Treasury bills settle.`;
    } catch {}
    return isBeta ? `Withdrew ${fmt(amt, 0)} to your Plutos wallet.` : `Withdrew ${fmt(amt, 0)} back to your test dollars.`;
  });
}

function amountInput() {
  const raw = String($("amount").value || "").trim();
  if (!raw || !(Number(raw) > 0)) {
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

async function run(btn, calls, successMsg) {
  if (busy) return;
  busy = true;
  const label = btn.textContent;
  setBusy(btn, btn === $("go") ? "Working…" : "…");
  try {
    const hash = await act(calls, (m) => setBusy(btn, m));
    await refresh();
    const msg = await successMsg(hash);
    toast(`${msg} ${txLink(hash)}`, false, 8000);
  } catch (x) {
    console.error(x);
    toastError(x);
  } finally {
    busy = false;
    clearBusy(btn, btn === $("go") ? goLabel() : label);
  }
}

function setBusy(btn, text) {
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> <span class="status"></span>`;
  btn.querySelector(".status").textContent = text;
}
function clearBusy(btn, text) {
  btn.disabled = false;
  btn.textContent = text;
}

// ------------------------------------------------------------------ entries and odds

const dollars = (x) => Math.floor(Number(formatUnits(x, 6)));
function times(x) {
  if (!isFinite(x)) return "—";
  const v = x >= 10 ? Math.round(x).toLocaleString("en-US") : String(Number(x.toFixed(1)));
  return v + "×";
}

function updatePreview() {
  const el = $("boostPreview");
  const v = Number($("amount").value);
  $("amount").style.width = Math.max(1.5, String($("amount").value || "").length + 0.4) + "ch";
  if (!busy) $("go").textContent = goLabel();
  const bal = Number(formatUnits(s.savings, 6));
  if (needsMoney()) return (el.textContent = "Your Plutos wallet is empty");
  if (!v || v <= 0) return (el.innerHTML = "&nbsp;");
  if (tab === "deposit") {
    el.textContent = bal >= 1 ? `${times((bal + v) / bal)} your odds` : `${Math.floor(v).toLocaleString("en-US")} entries in every draw`;
  } else {
    const left = Math.max(0, bal - v);
    el.textContent = left >= 1 ? `Leaves ${Math.floor(left).toLocaleString("en-US")} entries` : "Leaves you out of the next draw";
  }
}

function updateHint() {
  const b = document.createElement("b");
  b.textContent = tab === "deposit" ? fmt(s.wallet) : fmt(s.savings);
  $("hint").replaceChildren(
    tab === "deposit" ? (isBeta ? "In your Plutos wallet: " : "Test dollars available: ") : "In savings: ",
    b,
    tab === "deposit" ? "" : ". Always yours to take out."
  );
}

/** For new savers: 1 add money, 2 save it, 3 you're in. */
function renderStarter() {
  const st = $("starter");
  st.hidden = s.savings > 0n;
  if (st.hidden) return;
  const step = s.wallet > 0n ? "save" : "add";
  st.querySelectorAll("li").forEach((li) => {
    const k = li.dataset.step;
    li.className = k === step ? "now" : k === "add" && step === "save" ? "done" : "";
  });
  if (!isBeta) st.querySelector('[data-step="add"] b').textContent = "Get test dollars";
}

// ------------------------------------------------------------------ reading state

async function refresh() {
  if (!state.address) return;
  try {
    const block = await state.pub.getBlock();
    s.chainOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
    const [bal, wal, odds, drawer, reserve, interest, nd, ps, per, curId, splits, feeBps, apy, speed, minDep] = await Promise.all([
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
      read("vault", "minDeposit").catch(() => s.minDeposit),
    ]);
    Object.assign(s, { savings: bal, wallet: wal, nextDraw: nd, periodStart: ps, period: per, minDeposit: minDep, loaded: true });
    const keep = Number(10000n - feeBps) / 10000;
    s.pool = reserve + (interest * (10000n - feeBps)) / 10000n;
    s.poolAt = Date.now();
    s.ratePerSec = ((Number(drawer[1]) * Number(apy) * Number(speed)) / (10000 * YEAR)) * keep;

    $("savings").textContent = fmt(bal);
    $("getDollars").hidden = isBeta || wal > 0n || bal > 0n;
    $("faucetMore").hidden = isBeta || !$("getDollars").hidden;
    beta?.renderWallet(wal, bal);
    $("winnersN").textContent = splits.length.toLocaleString();

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

    renderStarter();
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
  const rows = await Promise.all(ids.map(getDrawCached));
  const me = state.address.toLowerCase();
  checkForWins(ids, rows, me);
  let wonTotal = 0n;
  rows.forEach(([, winners, amounts]) => winners.forEach((w, j) => w.toLowerCase() === me && (wonTotal += amounts[j])));
  setWon(wonTotal);
  renderLast(ids, rows, me);
}

/** The newest draw with winners, as one line that opens the Draws page. */
function renderLast(ids, rows, me) {
  const i = rows.findIndex(([d, winners]) => d.awarded && winners.length);
  const el = $("lastDraw");
  if (i < 0) return (el.hidden = true);
  const [d, winners, amounts] = rows[i];
  let mine = 0n;
  winners.forEach((w, j) => w.toLowerCase() === me && (mine += amounts[j]));
  const total = amounts.reduce((a, b) => a + b, 0n);
  const people = groupWinners(winners, amounts).length;
  const when = new Date(Number(d.closeTime) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  el.hidden = false;
  el.classList.toggle("mine", mine > 0n);
  $("ldId").textContent = `#${ids[i]}`;
  $("ldTitle").textContent = mine > 0n ? `You won ${fmt(mine)} in draw #${ids[i]}` : `Draw #${ids[i]}: ${fmt(total)} to ${people} saver${people === 1 ? "" : "s"}`;
  $("ldSub").textContent = `${when} · See the winners and how they were picked`;
  $("ldAmt").textContent = mine > 0n ? `+${fmt(mine)}` : "";
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

// ------------------------------------------------------------------ live pool and countdown

function tick() {
  if (!s.periodStart) return;
  const nowSec = Date.now() / 1000 + s.chainOffset;
  const poolNow = Number(s.pool) + s.ratePerSec * ((Date.now() - s.poolAt) / 1000);
  const start = Number(s.periodStart);
  const end = Number(s.nextDraw);
  $("pool").textContent = fmtFloat(poolNow);

  let left = Math.floor(end - nowSec);
  if (admin) $("drawLink").textContent = left <= 0 ? "Pick the winners now" : "Open the draw controls";
  $("roundFill").style.width = `${Math.min(100, Math.max(0, ((nowSec - start) / Math.max(1, end - start)) * 100))}%`;
  const clock = (t) => new Date((t - s.chainOffset) * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  $("roundStart").textContent = `Round started ${clock(start)}`;
  $("roundEnd").textContent = `Draw ${clock(end)}`;
  if (left <= 0) {
    $("countdown").textContent = "Any moment";
    $("poolProj").textContent = "The round is over. Winners are picked next.";
  } else {
    $("poolProj").textContent = `About ${fmtFloat(poolNow + s.ratePerSec * left)} by the draw`;
    const d = Math.floor(left / 86400);
    left %= 86400;
    const h = Math.floor(left / 3600);
    left %= 3600;
    const m = Math.floor(left / 60);
    const pad = (x) => String(x).padStart(2, "0");
    $("countdown").textContent = d ? `${d}d ${pad(h)}h ${pad(m)}m` : `${h ? h + ":" : ""}${pad(m)}:${pad(left % 60)}`;
  }
}

const fmtFloat = (base) => "$" + (Math.max(0, base) / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ------------------------------------------------------------------ winner celebration

function seenKey() {
  return `kairos.celebrated.${state.cfg.vault}.${state.address}`.toLowerCase();
}
function checkForWins(ids, rows, me) {
  let seen = [];
  try {
    seen = JSON.parse(localStorage.getItem(seenKey()) || "[]");
  } catch {}
  if (!Array.isArray(seen)) seen = [];
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
  if ($("ds") && !$("ds").hidden) return; // a draw is playing; it shows the win itself
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
  const colors = ["#CDAE6D", "#E3CB94", "#F2EDE4", "#f5c542", "#CDAE6D"];
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

main().catch((e) => {
  console.error(e);
  toast("Something went wrong loading Plutos. Refresh the page.", true, 0);
});
