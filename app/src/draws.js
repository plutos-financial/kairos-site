// The Draws page.
//   Everyone: the countdown, the latest winners, past draws, replays of how each draw was picked,
//   watching a draw live while Chainlink answers, and pretend draws (nothing on-chain).
//   The Plutos team (the on-chain owner, or an email on the drawAdmins list): real draws, settings,
//   auto-pilot. Ending a round early and the settings also need on-chain owner rights, which the
//   team's email account gets through the one-time MetaMask handover below.
import { createWalletClient, custom, parseEventLogs } from "viem";
import abis from "./abis.json";
import {
  $, PRIZE_PRESETS, state, fmt, short, sleep, setup, read, act, friendlyError, toast, toastError, txLink, humanDuration,
  resumeEmailSession, connectBrowserWallet, connectDevKey, canRunDraws, usesChainlink,
} from "./core.js";
import { openPretend } from "./pretend.js";
import { replayDraw, watchDraw } from "./drawshow.js";
import { showAccount, wireAccount } from "./appbar.js";
import { loadDraws, latestWithWinners, podiumHTML, groupWinners, drawTotal, drawWhen, avatar, saverName, myWin } from "./winners-ui.js";

let owner = "";
let nextDraw = 0n;
let periodStart = 0n;
let period = 0n;
let currentId = 0n;
let pendingId = 0n; // a round that closed but hasn't had winners picked yet
let paused = false;
let chainOffset = 0;
let busy = false;
let admin = false; // may run real draws
let allowlistOn = false; // kept as-is when the smallest deposit changes

async function main() {
  if (!(await setup())) return toast(`No contracts yet. <a href="./deploy.html">Set them up</a>.`, true, 0);
  wireAccount();
  if (!connectDevKey()) await resumeEmailSession();
  wire();
  await refresh();
  setInterval(refresh, 6000);
  setInterval(tick, 1000);
}

function isOwner() {
  return Boolean(state.address && owner && state.address.toLowerCase() === owner.toLowerCase());
}

const chainNow = () => BigInt(Math.floor(Date.now() / 1000) + chainOffset);

function wire() {
  $("useWallet").onclick = async () => {
    try {
      await connectBrowserWallet();
      await refresh();
    } catch (e) {
      toastError(e);
    }
  };
  $("handover").onclick = handover;

  document.querySelectorAll("[data-ff]").forEach((b) => {
    // Invest the cash drawer's excess first, so the skipped time actually earns interest.
    b.onclick = () =>
      go(b, [{ c: "vault", fn: "rebalance" }, { c: "tbill", fn: "fastForward", args: [BigInt(b.dataset.ff)] }], "Interest added. The prize pool grew.");
  });
  $("setSpeed").onclick = (e) => go(e.currentTarget, [{ c: "tbill", fn: "setSpeed", args: [BigInt($("speedSel").value)] }], "Interest speed updated.");
  document.querySelectorAll("[data-period]").forEach((b) => {
    b.onclick = () => go(b, [{ c: "vault", fn: "setDrawPeriod", args: [BigInt(b.dataset.period)] }], `Rounds now last ${humanDuration(Number(b.dataset.period))}.`);
  });
  $("tick").onclick = (e) => go(e.currentTarget, [{ c: "vault", fn: "rebalance" }], "Rebalanced the cash drawer.");
  $("weekend").onclick = (e) => go(e.currentTarget, [{ c: "tbill", fn: "setRules", args: [0n, 0n, 120n, false] }], "Weekend mode: big withdrawals wait for T-bills to settle.");
  $("instant").onclick = (e) => go(e.currentTarget, [{ c: "tbill", fn: "setRules", args: [0n, 0n, 120n, true] }], "Weekday mode: instant route on.");
  $("payFees").onclick = (e) => go(e.currentTarget, [{ c: "vault", fn: "payFees" }], "Fees sent to the treasury.");
  $("pause").onclick = (e) => go(e.currentTarget, [{ c: "vault", fn: paused ? "unpause" : "pause" }], paused ? "Deposits resumed." : "Deposits paused. Withdrawals still work.");
  $("drawNow").onclick = () => drawNow();
  if (!usesChainlink()) $("drawSteps").querySelector('[data-step="2"]').textContent = "Get a random number";
  $("pretendBtn").onclick = () => openPretend();
  $("latestReplay").onclick = () => latestId && replayDraw(latestId);
  $("history").addEventListener("click", (e) => {
    const b = e.target.closest("[data-replay]");
    if (b) replayDraw(BigInt(b.dataset.replay));
  });
  document.querySelectorAll("[data-splits]").forEach((b) => {
    const preset = PRIZE_PRESETS[b.dataset.splits];
    b.onclick = () => go(b, [{ c: "vault", fn: "setPrizeSplits", args: [preset] }], `Prize structure set: ${preset.length} prizes per round.`);
  });
  document.querySelectorAll("[data-mindep]").forEach((b) => {
    b.onclick = () =>
      go(b, [{ c: "vault", fn: "setDepositRules", args: [BigInt(b.dataset.mindep), allowlistOn] }], `The smallest deposit is now ${fmt(BigInt(b.dataset.mindep), 0)}.`);
  });
  $("autopilot").onchange = (e) => (e.target.checked ? startAutopilot() : stopAutopilot());
}

async function go(btn, calls, msg) {
  if (busy) return;
  if (!state.address) return toast("Sign in first.", true);
  busy = true;
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>`;
  try {
    const hash = await act(calls, (m) => (btn.innerHTML = `<span class="spinner"></span> ${m}`));
    toast(`${msg} ${txLink(hash)}`, false, 7000);
    await refresh();
    return hash;
  } catch (e) {
    console.error(e);
    toastError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    busy = false;
  }
}

// ------------------------------------------------------------------ the draw

/** Pulls the vault's events out of every transaction the last action sent. */
async function vaultEvents(eventName) {
  const out = [];
  for (const hash of state.lastHashes) {
    const r = await state.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    out.push(...parseEventLogs({ abi: abis.KairosVault, logs: r.logs, eventName }).filter((l) => l.address.toLowerCase() === state.cfg.vault.toLowerCase()));
  }
  return out;
}

/** Shows the three draw steps and marks where we are: 1 close, 2 random number, 3 pay. */
function setStep(n) {
  const list = $("drawSteps");
  list.hidden = n === 0;
  list.querySelectorAll("li").forEach((li) => {
    const k = Number(li.dataset.step);
    li.className = k < n || n === 4 ? "done" : k === n ? "now" : "";
  });
}

async function drawNow() {
  // Everyone else: watch a real draw while Chainlink answers, or run a pretend one.
  if (!admin) return pendingId && usesChainlink() ? watchDraw(pendingId) : openPretend();
  if (busy) return;
  const btn = $("drawNow");
  busy = true;
  btn.disabled = true;
  const status = (m) => (btn.innerHTML = `<span class="spinner"></span> ${m}`);
  let ok = false;
  try {
    status("Checking the round…");
    const [cur, nd, ps, per, block] = await Promise.all([
      read("vault", "currentDrawId"),
      read("vault", "nextDrawTime"),
      read("vault", "periodStart"),
      read("vault", "drawPeriod"),
      state.pub.getBlock(),
    ]);
    const now = block.timestamp;

    // 1. An earlier round closed but its winners were never picked? Finish that first.
    const stuck = await findPending(cur);
    if (stuck) {
      setStep(2);
      await pickWinners(stuck, status);
      ok = true;
      return;
    }

    // 2. Close the round. If it isn't over yet, the owner can end it early in the same tap:
    //    shorten the round to 1 minute, close it, then put the round length back.
    let calls = [{ c: "vault", fn: "closeDraw" }];
    if (now < nd) {
      const left = Number(nd - now);
      if (!isOwner())
        return toast(`The next draw is in ${inWords(left)}. To skip the wait from this account, do the one-time setup below.`, true, 10000);
      if (now < ps + 60n)
        return toast(`A round has to run for at least a minute. Try again in ${Number(ps + 60n - now)} seconds.`, true, 7000);
      calls = [
        { c: "vault", fn: "setDrawPeriod", args: [60n] },
        { c: "vault", fn: "closeDraw" },
        { c: "vault", fn: "setDrawPeriod", args: [per] },
      ];
    }
    setStep(1);
    status("Closing the round…");
    await act(calls, status);
    const closed = (await vaultEvents("DrawClosed"))[0];
    if (!closed) throw new Error("The round didn't close. Wait a few seconds and try again.");
    const { drawId, prize, entrants } = closed.args;
    if (prize === 0n) {
      return toast(
        entrants === 0n
          ? `Round ${drawId} closed, but nobody had any savings in it, so there was no one to pick. Deposit in the app first.`
          : `Round ${drawId} closed, but the prize pool was empty. Press "Make the prize bigger" first, then try again.`,
        true,
        9000
      );
    }
    setStep(2);
    await pickWinners(drawId, status);
    ok = true;
  } catch (e) {
    console.error(e);
    toastError(e, 9000);
  } finally {
    busy = false;
    btn.disabled = false;
    if (ok) setStep(4);
    setTimeout(() => !busy && setStep(0), ok ? 2500 : 0);
    await refresh();
  }
}

/** Oldest of the last few rounds that closed with a prize but never had winners picked (0n if none). */
async function findPending(cur) {
  const ids = [];
  for (let id = cur - 1n; id >= 1n && ids.length < 6; id--) ids.push(id);
  const rows = await Promise.all(ids.map((id) => read("vault", "getDraw", [id])));
  let found = 0n;
  rows.forEach(([d], i) => d.prize > 0n && !d.awarded && (found = ids[i]));
  return found;
}

/** The random source needs one more block after the round closes, then anyone can finish it. */
async function pickWinners(drawId, status) {
  // The random number is already in but the winners weren't paid in the same step (a very big draw)?
  // Anyone can pay them: one walk down the vault's tree per prize.
  const [d0] = await read("vault", "getDraw", [drawId]);
  if (d0.randomReady && !d0.awarded) {
    setStep(3);
    status("Paying the winners…");
    await act([{ c: "vault", fn: "awardDraw", args: [drawId], gas: 8_000_000n }], status);
    setStep(4);
    return replayDraw(drawId);
  }
  if (usesChainlink()) {
    // Chainlink answers by itself, usually within a minute. Show it happening, live.
    status("Chainlink is picking a random number…");
    watchDraw(drawId);
    return;
  }
  status("Getting a random number…");
  const req = await read("rng", "requestBlock", [drawId]).catch(() => 0n);
  for (let i = 0; i < 30 && req > 0n; i++) {
    if ((await state.pub.getBlockNumber()) > req + 1n) break;
    await sleep(1000);
  }
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      setStep(3);
      status("Paying the winners…");
      // Who wins changes how much gas this needs, so give it plenty (unused gas isn't charged).
      await act([{ c: "rng", fn: "fulfill", args: [drawId], gas: 3_000_000n }], status);
      const ev = (await vaultEvents("DrawAwarded"))[0];
      if (ev) {
        setStep(4);
        return replayDraw(drawId);
      }
      const [d1] = await read("vault", "getDraw", [drawId]);
      if (d1.randomReady && !d1.awarded) {
        await act([{ c: "vault", fn: "awardDraw", args: [drawId], gas: 8_000_000n }], status);
        setStep(4);
        return replayDraw(drawId);
      }
      break;
    } catch (e) {
      lastErr = e;
      const m = friendlyError(e);
      if (/no request|nothing to award/i.test(m)) break; // someone else already finished it
      // "one more block": too early. "didn't go through"/"failed on-chain": usually ran short of gas
      // because the random number changed between the estimate and the real run. Both are safe to retry.
      if (!/one more block|didn't go through|failed on-chain/i.test(m)) throw e;
      await sleep(2500);
    }
  }
  // Read the result straight from the vault (covers "someone else finished it").
  const [d, winners, amounts] = await read("vault", "getDraw", [drawId]);
  if (d.awarded && winners.length) return replayDraw(drawId);
  throw lastErr || new Error("Couldn't pick winners yet. Press the button again in a few seconds.");
}

// ------------------------------------------------------------------ auto-pilot

let autoTimer = null;
let autoCount = 0;
async function autoTick() {
  if (busy || !admin) return;
  const statusEl = $("autoStatus");
  try {
    // Rebalance about every 90 seconds; check for a finished round every 30.
    if (autoCount++ % 3 === 0) {
      busy = true;
      statusEl.textContent = "Rebalancing…";
      await act([{ c: "vault", fn: "rebalance" }]);
      busy = false;
    }
    await refresh();
    const pool = (await read("vault", "prizeReserve")) + ((await read("vault", "availableInterest")) * 85n) / 100n;
    if ((chainNow() >= nextDraw && pool > 0n && !paused) || pendingId) {
      statusEl.textContent = "Round over: drawing winners…";
      await drawNow();
    }
    statusEl.textContent = `On. Last checked at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}.`;
  } catch (e) {
    busy = false;
    statusEl.textContent = `On, but the last check hit a problem: ${friendlyError(e)}`;
  }
}
function startAutopilot() {
  if (!admin) {
    $("autopilot").checked = false;
    return toast("Only the Plutos team can turn this on.", true);
  }
  if (state.mode === "wallet") toast("Heads up: with MetaMask, auto-pilot asks you to confirm every step. Hand over to your email account for hands-free auto-pilot.", false, 9000);
  $("autoStatus").textContent = "On. Starting…";
  autoTick();
  autoCount = 0;
  autoTimer = setInterval(autoTick, 30_000);
}
function stopAutopilot() {
  clearInterval(autoTimer);
  autoTimer = null;
  $("autoStatus").textContent = "Off. When on, winners are picked every time a round ends, as long as this page stays open.";
}

// ------------------------------------------------------------------ hand owner rights to the email account

async function handover() {
  const target = state.mode === "email" ? state.address : null;
  if (!target) return toast("Sign in with email on the app first.", true);
  if (!window.ethereum) return toast("MetaMask isn't installed in this browser.", true);
  const btn = $("handover");
  try {
    btn.disabled = true;
    const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const hexId = "0x" + state.chain.id.toString(16);
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] }).catch(() => {});
    if (addr.toLowerCase() !== owner.toLowerCase())
      return toast(`That MetaMask account (${short(addr)}) isn't the owner. Switch to ${short(owner)} in MetaMask and try again.`, true, 9000);
    const wc = createWalletClient({ chain: state.chain, account: addr, transport: custom(window.ethereum) });
    const steps = [["vault", state.contracts.vault], ["T-bill fund", state.contracts.tbill]];
    for (let i = 0; i < steps.length; i++) {
      const [name, c] = steps[i];
      const current = await state.pub.readContract({ ...c, functionName: "owner" });
      if (current.toLowerCase() === target.toLowerCase()) continue; // already done (e.g. a retry)
      toast(`Confirm in MetaMask (${i + 1} of 2): hand over the ${name}…`, false, 0);
      const hash = await wc.writeContract({ ...c, functionName: "transferOwnership", args: [target], account: addr });
      await state.pub.waitForTransactionReceipt({ hash });
    }
    await sleep(1500);
    toast("Done. Your email account now controls Plutos, and these buttons work without pop-ups.", false, 9000);
    await refresh();
  } catch (e) {
    console.error(e);
    toastError(e);
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ reading state

async function refresh() {
  try {
    const block = await state.pub.getBlock();
    chainOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
    const [o, tvl, savers, reserve, interest, feeBps, nd, ps, per, isPaused, drawer, fees, speed, delay, instant, cur, splits] = await Promise.all([
      read("vault", "owner"),
      read("vault", "totalSupply"),
      read("vault", "depositorCount"),
      read("vault", "prizeReserve"),
      read("vault", "availableInterest"),
      read("vault", "feeBps"),
      read("vault", "nextDrawTime"),
      read("vault", "periodStart"),
      read("vault", "drawPeriod"),
      read("vault", "paused"),
      read("vault", "drawerState"),
      read("vault", "feesAccrued"),
      read("tbill", "speed"),
      read("tbill", "settlementDelay"),
      read("tbill", "instantRedeemEnabled"),
      read("vault", "currentDrawId"),
      read("vault", "prizeSplits"),
    ]);
    const [minDep, allowlist] = await Promise.all([read("vault", "minDeposit"), read("vault", "requireAllowlist")]);
    allowlistOn = allowlist;
    document.querySelectorAll("[data-mindep]").forEach((b) => b.classList.toggle("on", b.dataset.mindep === String(minDep)));
    owner = o;
    nextDraw = nd;
    periodStart = ps;
    period = per;
    currentId = cur;
    paused = isPaused;
    const { draws } = await loadDraws(15);
    pendingId = 0n;
    draws.forEach((x) => x.d.prize > 0n && !x.d.awarded && (pendingId = x.id)); // oldest stuck round
    renderLatest(draws);
    renderHistory(draws);

    $("roundId").textContent = String(cur);
    $("tvl").textContent = fmt(tvl);
    $("savers").textContent = savers.toString();
    $("pool").textContent = fmt(reserve + (interest * (10000n - feeBps)) / 10000n);
    $("cash").textContent = fmt(drawer[0]);
    $("fees").textContent = fmt(fees);
    $("speed").textContent = Number(speed).toLocaleString();
    $("period").textContent = humanDuration(Number(per));
    $("fundRules").textContent = `T-bills settle in ${humanDuration(Number(delay))}. Instant route ${instant ? "on (weekday)" : "off (weekend)"}.`;
    $("pause").textContent = isPaused ? "Resume deposits" : "Pause deposits";
    document.querySelectorAll("[data-period]").forEach((b) => b.classList.toggle("on", b.dataset.period === String(per)));
    document.querySelectorAll("[data-splits]").forEach((b) => b.classList.toggle("on", Number(b.dataset.splits) === splits.length));
    syncSelect("speedSel", String(speed));
    $("updated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

    const me = state.address;
    admin = await canRunDraws(owner);
    showAccount({ admin });
    $("ownerLine").innerHTML = `Owner account: ${short(owner)}${isOwner() ? " (that's you)" : me ? `. You're signed in as ${short(me)}.` : ""}`;
    $("signedOut").hidden = Boolean(me);
    $("adminArea").hidden = !admin;
    $("pretendBtn").hidden = !admin;
    $("notOwner").hidden = !(admin && state.mode === "email" && !isOwner());
    // Settings need on-chain owner rights.
    document.querySelectorAll("#settings button, #settings select").forEach((el) => {
      if (!busy) el.disabled = !isOwner();
    });
    $("autopilot").disabled = !admin;
    if (!admin && autoTimer) stopAutopilot();
    tick();
  } catch (e) {
    console.error(e);
  }
}

let latestId = 0n;
function renderLatest(draws) {
  const x = latestWithWinners(draws);
  const card = $("latestCard");
  if (!x) return (card.hidden = true);
  card.hidden = false;
  latestId = x.id;
  const key = `${x.id}:${state.address || ""}`;
  if (card.dataset.key === key) return;
  card.dataset.key = key;
  const people = groupWinners(x.winners, x.amounts).length;
  const mine = myWin(x, state.address);
  $("latestTitle").textContent = `Draw #${x.id} winners`;
  $("latestBanner").hidden = mine === 0n;
  $("latestBanner").textContent = mine > 0n ? `That's you! You won ${fmt(mine)}. It's already in your savings.` : "";
  $("latestPodium").innerHTML = podiumHTML(x, state.address);
  $("latestMeta").textContent = `${fmt(drawTotal(x))} to ${people} saver${people === 1 ? "" : "s"} on ${drawWhen(x)}, out of ${x.entrants} who entered.`;
}

let historyKey = "";
function renderHistory(draws) {
  const key = draws.map((x) => `${x.id}:${x.d.awarded}`).join(",") + (state.address || "");
  if (key === historyKey) return;
  historyKey = key;
  const latest = latestWithWinners(draws);
  const rest = draws.filter((x) => x !== latest);
  $("historyCard").hidden = Boolean(latest) && !rest.length; // nothing older to show yet
  if (!rest.length) return ($("history").innerHTML = `<p class="sub">No draws yet. The first one happens when the countdown ends.</p>`);
  const me = state.address;
  $("history").innerHTML = rest
    .map((x) => {
      if (!x.d.awarded) return row(x, `<span class="badge wait">${x.d.randomReady ? "Paying the winners…" : "Chainlink is picking…"}</span>`, "");
      if (!x.winners.length) return row(x, `<span class="tiny">No prize this round</span>`, "");
      const g = groupWinners(x.winners, x.amounts);
      const top = g[0];
      const summary = `${avatar(top.addr)}<span><b>${saverName(top.addr, me)}</b> won ${fmt(top.amount)}${g.length > 1 ? ` <span class="tiny">+ ${g.length - 1} more</span>` : ""}</span>`;
      const list = g
        .map((w, i) => `<div class="rest-row${me && w.addr.toLowerCase() === me.toLowerCase() ? " me" : ""}"><span class="rest-n">${i + 1}</span>${avatar(w.addr)}<span class="rest-name">${saverName(w.addr, me)}${w.count > 1 ? ` <span class="tiny">${w.count} prizes</span>` : ""}</span><b>${fmt(w.amount)}</b></div>`)
        .join("");
      return row(x, summary, `<div class="pod-rest">${list}</div><div class="h-foot"><span class="tiny">${drawWhen(x)}. ${x.entrants} saver${x.entrants === 1n ? "" : "s"} entered.</span><button class="btn btn-ghost btn-sm" type="button" data-replay="${x.id}">See how they were picked</button></div>`);
    })
    .join("");
}

function row(x, summary, detail) {
  const head = `<span class="h-id">#${x.id}</span><span class="h-sum">${summary}</span><span class="h-amt">${x.winners.length ? fmt(drawTotal(x)) : ""}</span>`;
  return detail
    ? `<details class="h-row"><summary>${head}</summary>${detail}</details>`
    : `<div class="h-row plain"><div class="h-line">${head}</div></div>`;
}

function syncSelect(id, value) {
  const el = $(id);
  if (document.activeElement === el) return;
  if ([...el.options].some((o) => o.value === value)) el.value = value;
}

function inWords(sec) {
  if (sec < 90) return `${Math.max(1, sec)} seconds`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} minutes`;
  if (sec < 172800) return `about ${Math.round(sec / 3600)} hours`;
  return `about ${Math.round(sec / 86400)} days`;
}

function clock(sec) {
  if (sec >= 86400) return humanDuration(Math.ceil(sec / 3600) * 3600);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
}

/** Keeps the draw card in plain words: what's happening, and what the button will do. */
function tick() {
  if (!nextDraw) return;
  const left = Number(nextDraw) - (Math.floor(Date.now() / 1000) + chainOffset);
  const sinceStart = Number(chainNow() - periodStart);
  const btn = $("drawNow");
  let title, hint, label, enabled = true;
  if (!admin) {
    $("roundState").textContent = pendingId ? "picking winners" : left <= 0 ? "finished" : "open";
    if (pendingId && usesChainlink()) {
      title = "Chainlink is picking the winners";
      hint = `Round ${pendingId} is closed and Chainlink's random number is on its way. Watch the winners get picked.`;
      label = "Watch it live";
    } else {
      title = left > 0 && !pendingId ? `Next draw in ${clock(left)}` : "This round is over";
      hint = left > 0 && !pendingId
        ? "When the countdown ends, Chainlink picks the winners. See exactly how, with a pretend draw."
        : "The winners will be picked shortly. Meanwhile, here's how a draw works.";
      label = "See how a draw works";
    }
  } else if (pendingId && usesChainlink()) {
    $("roundState").textContent = "waiting for Chainlink";
    title = "Chainlink is picking the winners";
    hint = `Round ${pendingId} closed. Chainlink sends the random number by itself, usually within a minute.`;
    label = "Watch the draw";
  } else if (pendingId) {
    $("roundState").textContent = "waiting for winners";
    title = "Winners haven't been picked yet";
    hint = `Round ${pendingId} closed, but its winners weren't picked. Press the button to finish it.`;
    label = "Finish picking winners";
  } else if (left <= 0) {
    $("roundState").textContent = "finished";
    title = "Ready to pick winners";
    hint = "This round is over. Press the button and Plutos picks the winners.";
    label = "Pick winners now";
  } else {
    $("roundState").textContent = "open";
    title = `Next draw in ${clock(left)}`;
    if (isOwner() && sinceStart < 60) {
      hint = `A round has to run for at least a minute. You can skip the wait in ${60 - sinceStart} seconds.`;
      label = "Skip the wait";
      enabled = false;
    } else if (isOwner()) {
      hint = "You're the owner, so you don't have to wait for the countdown.";
      label = "Skip the wait and pick winners";
    } else {
      hint = "When the countdown hits zero, press the button. To skip the wait, finish the one-time setup below.";
      label = `Pick winners in ${clock(left)}`;
      enabled = false;
    }
  }
  $("drawTitle").textContent = title;
  $("drawHint").textContent = hint;
  if (!busy) {
    btn.textContent = label;
    btn.disabled = !enabled;
  }
}

main().catch((e) => {
  console.error(e);
  toast("Something went wrong loading the controls.", true, 0);
});
