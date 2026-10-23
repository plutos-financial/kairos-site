// Control room: live Rebalancer view, draw simulator, activity feed.
import { keccak256, encodeAbiParameters, formatUnits, parseUnits } from "viem";
import { $, PRIZE_PRESETS, state, fmt, short, setup, read, act, friendlyError, toast, toastError, txLink, humanDuration, resumeEmailSession, connectDevKey, readPages } from "./core.js";
import { saverName } from "./winners-ui.js";

const YEAR = 365n * 24n * 3600n;

let s = null; // latest on-chain snapshot
let chainOffset = 0;

// ------------------------------------------------------------------ snapshot

async function snapshot() {
  const block = await state.pub.getBlock();
  chainOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
  const v = state.cfg.vault;
  const [
    tvl, drawer, reserve, pendingPrizes, fees, queuedTotal, feeBps, nextDraw, period, splits, savers,
    lowBps, highBps, emBps, smallLimit, navCp, cpTime, apy, speed, tokens, minSub, minRed, delay, instant,
  ] = await Promise.all([
    read("vault", "totalSupply"), read("vault", "drawerState"), read("vault", "prizeReserve"), read("vault", "prizesPending"),
    read("vault", "feesAccrued"), read("vault", "queuedTotal"), read("vault", "feeBps"), read("vault", "nextDrawTime"),
    read("vault", "drawPeriod"), read("vault", "prizeSplits"), read("vault", "depositorCount"),
    read("vault", "lowBps"), read("vault", "highBps"), read("vault", "emergencyBps"), read("vault", "smallInstantLimit"),
    read("tbill", "navCheckpoint"), read("tbill", "checkpointTime"), read("tbill", "apyBps"), read("tbill", "speed"),
    read("tbill", "balanceOf", [v]), read("tbill", "minSubscription"), read("tbill", "minRedemption"),
    read("tbill", "settlementDelay"), read("tbill", "instantRedeemEnabled"),
  ]);
  const [cash, , pending, queued, r, low, high, emerg] = drawer;
  s = { tvl, cash, pending, queued, r, low, high, emerg, reserve, pendingPrizes, fees, queuedTotal, feeBps, nextDraw, period, splits, savers, lowBps, highBps, emBps, smallLimit, navCp, cpTime, apy, speed, tokens, minSub, minRed, delay, instant };
}

const nowChain = () => BigInt(Math.floor(Date.now() / 1000) + chainOffset);
// Same formula as MockTBill.nav(), so the value ticks smoothly between reads.
const navAt = (t) => s.navCp + (s.navCp * s.apy * (t - s.cpTime) * s.speed) / (10000n * YEAR);
const fundValue = (t) => (s.tokens * navAt(t)) / 10n ** 18n;
const interestAt = (t) => {
  const assets = s.cash + fundValue(t) + s.pending;
  const owed = s.tvl + s.queuedTotal + s.reserve + s.pendingPrizes + s.fees;
  return assets > owed ? assets - owed : 0n;
};

// ------------------------------------------------------------------ rendering

function renderLive() {
  if (!s) return;
  const t = nowChain();
  $("kTvl").textContent = fmt(s.tvl);
  $("kCash").textContent = fmt(s.cash);
  $("kFund").textContent = fmt(fundValue(t));
  $("kPending").textContent = fmt(s.pending);
  $("kQueued").textContent = fmt(s.queued);
  $("kInterest").textContent = fmt(interestAt(t));
  $("navLine").textContent = `One T-bill share is worth $${(Number(navAt(t)) / 1e18).toFixed(6)}. It earns ${(Number(s.apy) / 100).toFixed(2)}% a year, sped up ${Number(s.speed).toLocaleString()} times for the demo.`;
}

function renderBand() {
  const max = Number(s.r) * 1.5 || 1;
  const pct = (x) => Math.max(0, Math.min(100, (Number(x) / max) * 100));
  $("zE").style.width = pct(s.emerg) + "%";
  $("zL").style.width = pct(s.low) - pct(s.emerg) + "%";
  $("zH").style.width = pct(s.high) - pct(s.low) + "%";
  $("zX").style.width = 100 - pct(s.high) + "%";
  $("mR").style.left = `calc(${pct(s.r)}% - 1px)`;
  $("needle").style.left = `calc(${pct(s.cash)}% - 2px)`;
  $("needleLabel").textContent = fmt(s.cash, 0);
  $("sE").textContent = `E ${fmt(s.emerg, 0)}`;
  $("sL").textContent = `L ${fmt(s.low, 0)}`;
  $("sR").textContent = `R ${fmt(s.r, 0)}`;
  $("sU").textContent = `U ${fmt(s.high, 0)}`;

  // Mirror KairosVault.rebalance() to preview the next decision.
  const incoming = s.cash + s.pending;
  const effective = incoming > s.queued ? incoming - s.queued : 0n;
  const held = fundValue(nowChain());
  let action, rule, status;
  if (effective < s.low) {
    let want = s.r + s.queued > incoming ? s.r + s.queued - incoming : 0n;
    if (want < s.minRed) want = s.minRed;
    if (want > held) want = held;
    rule = "ruleLow";
    status = "Below the floor";
    action = want > 0n && want >= s.minRed ? `Sell ${fmt(want)} of T-bills to refill the cash. It arrives in ${humanDuration(Number(s.delay))}.` : "Wait. Cash is low, but there are no T-bills left to sell.";
  } else if (s.cash > s.high && s.queued === 0n) {
    let excess = s.cash - s.r;
    excess = s.fees < excess ? excess - s.fees : 0n;
    rule = "ruleHigh";
    status = "Above the ceiling";
    action = excess > 0n && excess >= s.minSub ? `Move ${fmt(excess)} of extra cash into T-bills so it earns interest.` : "Nothing. The extra cash is too small to invest.";
  } else {
    rule = "ruleHold";
    status = "Healthy";
    action = "Nothing. There's the right amount of cash.";
  }
  $("bandStatus").textContent = `${fmt(s.cash)} in cash right now. The target is ${fmt(s.r)}.`;
  $("nextAction").textContent = action;
  ["ruleLow", "ruleHold", "ruleHigh"].forEach((id) => $(id).classList.toggle("on", id === rule));
  $("routerNote").textContent = `Withdrawals are paid instantly if at least ${fmt(s.emerg, 0)} stays in cash afterward, or if they're ${fmt(s.smallLimit, 0)} or less. Bigger ones ${s.instant ? "use the fund's instant sale (weekday mode)" : "wait until T-bills are sold (weekend mode)"}.`;

  const parts = [
    ["Cash", s.cash, "var(--green)"],
    ["Treasury bills", held, "var(--blue)"],
    ["Being sold", s.pending, "var(--amber)"],
  ];
  const total = parts.reduce((a, [, v]) => a + v, 0n) || 1n;
  $("splitBar").innerHTML = parts.map(([n, v, c]) => `<div title="${n}" style="width:${(Number(v) / Number(total)) * 100}%;background:${c}"></div>`).join("");
  $("splitLegend").innerHTML = parts
    .map(([n, v, c]) => `<span><i style="background:${c}"></i>${n} ${fmt(v)} (${((Number(v) / Number(total)) * 100).toFixed(0)}%)</span>`)
    .join("");
}

// ------------------------------------------------------------------ activity feed

const ICON = { Deposited: "↓", Withdrawn: "↑", WithdrawalQueued: "…", QueuePaid: "✓", Harvested: "+", Rebalanced: "⇄", RedemptionSettled: "✓", DrawClosed: "#", DrawAwarded: "★", FeesPaid: "$" };

function describe(e) {
  const a = e.args;
  const who = (x) => saverName(x, state.address);
  switch (e.eventName) {
    case "Deposited": return `${who(a.user)} saved ${fmt(a.amount)}`;
    case "Withdrawn": return `${who(a.user)} took out ${fmt(a.amount)}${a.route === "drawer" ? " instantly" : ""}`;
    case "WithdrawalQueued": return `${who(a.user)} asked to take out ${fmt(a.amount)}. It's waiting for T-bills to turn into cash.`;
    case "QueuePaid": return `${who(a.user)} got their ${fmt(a.amount)}`;
    case "Harvested": return `${fmt(a.interest)} of interest collected: ${fmt(a.toPrizes)} for prizes, ${fmt(a.toFees)} for Plutos`;
    case "Rebalanced":
      if (a.action === "invest") return `Moved ${fmt(a.amount)} of cash into T-bills`;
      if (a.action === "redeem") return `Sold ${fmt(a.amount)} of T-bills to get more cash`;
      if (a.action === "hold") return "Checked the cash. Nothing to do.";
      return "Checked the cash. It's low, and there's nothing to sell.";
    case "RedemptionSettled": return `${fmt(a.amount)} from a T-bill sale arrived as cash`;
    case "DrawClosed": return `Round ${a.drawId} closed with a ${fmt(a.prize)} prize pool and ${a.entrants} saver${a.entrants === 1n ? "" : "s"}`;
    case "DrawAwarded": {
      const by = new Map();
      a.winners.forEach((w, i) => by.set(w, (by.get(w) || 0n) + a.amounts[i]));
      return `Round ${a.drawId} winners: ${[...by.entries()].map(([w, t]) => `${who(w)} won ${fmt(t)}`).join(", ")}`;
    }
    case "FeesPaid": return `${fmt(a.amount)} in fees paid to Plutos`;
    default: return e.eventName;
  }
}

async function loadFeed() {
  try {
    const latest = await state.pub.getBlockNumber();
    const latestBlock = await state.pub.getBlock({ blockNumber: latest });
    const events = [];
    const step = 5000n;
    for (let k = 0n; k < 8n && events.length < 40; k++) {
      const to = latest - k * step;
      if (to < 0n) break;
      const from = to - step + 1n > 0n ? to - step + 1n : 0n;
      const chunk = await state.pub.getContractEvents({ ...state.contracts.vault, fromBlock: from, toBlock: to });
      events.unshift(...chunk);
      if (from === 0n) break;
    }
    const recent = events.filter((e) => ICON[e.eventName]).slice(-40).reverse();
    if (!recent.length) return ($("feed").innerHTML = `<p class="sub">Nothing yet. Deposit in the app to get things moving.</p>`);
    const secs = state.cfg.chainId === 84532 ? 2 : 1;
    $("feed").innerHTML = recent
      .map((e) => {
        const ago = Number(latest - e.blockNumber) * secs;
        const when = new Date((Number(latestBlock.timestamp) - ago) * 1000);
        const link = state.explorer ? `<a href="${state.explorer}/tx/${e.transactionHash}" target="_blank" rel="noopener noreferrer">Receipt</a>` : "";
        return `<div class="ev"><span class="ico">${ICON[e.eventName] || "•"}</span><div class="t">${describe(e)}</div><div class="when">${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ${link}</div></div>`;
      })
      .join("");
  } catch (e) {
    console.warn(e);
    $("feed").innerHTML = `<p class="sub">Couldn't load activity right now.</p>`;
  }
}

// ------------------------------------------------------------------ draw simulator

async function runSimulation() {
  const btn = $("simGo");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    await snapshot();
    const runs = Number($("simRuns").value);
    const when = $("simWhen").value;
    const extraRaw = String($("simExtra").value || "").trim();
    const extra = extraRaw && Number(extraRaw) > 0 ? parseUnits(extraRaw, 6) : 0n;
    const t = nowChain();
    const end = when === "end" && s.nextDraw > t ? s.nextDraw : t;
    const structure = $("simStructure").value;
    const splits = structure === "current" ? s.splits.map(Number) : PRIZE_PRESETS[structure];

    // Projected pool: what's there now, plus interest the T-bills earn until the draw.
    const accrue = s.tokens > 0n ? (fundValue(end) - fundValue(t)) : 0n;
    const pool = ((interestAt(t) + accrue) * (10000n - s.feeBps)) / 10000n + s.reserve;

    // Real savers and their weights (balance x time held this round).
    const pages = await readPages(s.savers, (start, count) => read("vault", "currentLine", [end, start, count]));
    const people = pages.flatMap(([addrs, weights]) => addrs.map((a, i) => ({ who: a, w: weights[i], bal: 0n }))).filter((p) => p.w > 0n);
    const bals = await Promise.all(people.map((p) => read("vault", "balanceOf", [p.who])));
    people.forEach((p, i) => (p.bal = bals[i]));
    if (extra > 0n) {
      // A pretend saver who deposits now and holds until the draw.
      const w = extra * (end > t ? end - t : 1n);
      people.push({ who: "pretend", w, bal: extra, pretend: true });
    }
    if (!people.length) {
      $("simOut").innerHTML = `<p class="sub">Nobody has savings in this round yet. Deposit in the app, or type a pretend deposit above.</p>`;
      return;
    }

    const cum = [];
    let total = 0n;
    for (const p of people) cum.push((total += p.w));
    const pick = (ticket) => {
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] > ticket) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const amounts = splits.map((b) => (pool * BigInt(b)) / 10000n);
    const wins = people.map(() => 0);
    const won = people.map(() => 0n);
    let sample = null;
    const rnd = new Uint8Array(32);
    for (let r = 0; r < runs; r++) {
      crypto.getRandomValues(rnd);
      const word = BigInt("0x" + [...rnd].map((b) => b.toString(16).padStart(2, "0")).join(""));
      const hit = new Set();
      const thisDraw = [];
      for (let i = 0; i < splits.length; i++) {
        // Same as the contract: keccak256(abi.encode(randomWord, i)) % totalWeight
        const ticket = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [word, BigInt(i)]))) % total;
        const idx = pick(ticket);
        hit.add(idx);
        won[idx] += amounts[i];
        thisDraw.push([idx, amounts[i]]);
      }
      hit.forEach((idx) => wins[idx]++);
      if (r === 0) sample = thisDraw;
      if (r % 500 === 499) await new Promise((res) => setTimeout(res)); // keep the page responsive
    }

    const label = (p) => (p.pretend ? "You (pretend)" : saverName(p.who, state.address));
    // Show odds as boosts (relative to the saver with the fewest entries), never as exact percentages.
    const minW = people.reduce((m, p) => (p.w < m ? p.w : m), people[0].w);
    const rows = people
      .map((p, i) => ({ p, wins: wins[i], boost: Number((p.w * 1000n) / (minW || 1n)) / 1000, avg: won[i] / BigInt(runs) }))
      .sort((a, b) => b.wins - a.wins);
    const maxWins = Math.max(...rows.map((r) => r.wins), 1);
    const bx = (x) => (x >= 10 ? Math.round(x).toLocaleString() : Number(x.toFixed(1)).toString()) + "×";

    $("simOut").innerHTML = `
      <div class="sim-summary">
        <div><p class="label">Prize pool</p><p class="mid">${fmt(pool)}</p><p class="tiny">${when === "end" ? `at the draw in ${inWords(Number(end - t))}` : "if drawn now"}</p></div>
        <div><p class="label">Prizes each draw</p><p class="mid">${splits.length}</p><p class="tiny">Biggest is ${fmt(amounts[0] || 0n)}</p></div>
        <div><p class="label">Savers in the draw</p><p class="mid">${people.length}</p><p class="tiny">${runs.toLocaleString()} pretend draws</p></div>
      </div>
      <table class="sim">
        <thead><tr><th>Saver</th><th>Savings</th><th>Odds boost</th><th>Won something in</th><th>Average prize</th></tr></thead>
        <tbody>${rows
          .map(
            ({ p, wins: w, boost, avg }) => `<tr class="${p.pretend ? "pretend" : ""}">
              <td><b>${label(p)}</b></td>
              <td class="mono">${fmt(p.bal)}</td>
              <td class="boostcell">${bx(boost)}</td>
              <td><div class="barcell"><div class="bar" style="width:${(w / maxWins) * 140}px"></div><span class="tiny">${w.toLocaleString()} of ${runs.toLocaleString()}</span></div></td>
              <td class="mono">${fmt(avg)}</td></tr>`
          )
          .join("")}</tbody>
      </table>
      <div class="sample"><b>One pretend draw:</b> ${sampleText(sample, people, label)}.</div>
      <p class="tiny">Odds boost compares each saver with whoever has the fewest entries. Entries count dollars and how long they've been saved this round. One person can win more than one prize.</p>`;
  } catch (e) {
    console.error(e);
    toastError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run pretend draws";
  }
}

function inWords(sec) {
  if (sec < 90) return `${Math.max(1, sec)} seconds`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} minutes`;
  if (sec < 172800) return `about ${Math.round(sec / 3600)} hours`;
  return `about ${Math.round(sec / 86400)} days`;
}

// Group a draw's prizes by winner: "Alice wins 3 prizes ($12.40), Bob wins $2.10"
function sampleText(sample, people, label) {
  const by = new Map();
  for (const [idx, amt] of sample) {
    const cur = by.get(idx) || { n: 0, total: 0n };
    cur.n++;
    cur.total += amt;
    by.set(idx, cur);
  }
  return [...by.entries()]
    .sort((a, b) => (b[1].total > a[1].total ? 1 : -1))
    .map(([idx, { n, total }]) => `${label(people[idx])} won ${n > 1 ? `${n} prizes (${fmt(total)})` : fmt(total)}`)
    .join(", ");
}

// ------------------------------------------------------------------ start

async function refresh() {
  try {
    await snapshot();
    renderLive();
    renderBand();
  } catch (e) {
    console.error(e);
  }
}

async function main() {
  if (!(await setup())) return toast(`No contracts yet. <a href="./deploy.html">Set them up</a>.`, true, 0);
  if (!connectDevKey()) resumeEmailSession();
  await refresh();
  loadFeed();
  setInterval(refresh, 8000);
  setInterval(loadFeed, 20000);
  setInterval(renderLive, 250);

  $("simGo").onclick = runSimulation;
  $("runNow").onclick = async (e) => {
    const btn = e.currentTarget;
    if (!state.address) return toast(`Sign in on the <a href="./app.html">app</a> first, then come back. Anyone signed in can press this.`, true, 8000);
    btn.disabled = true;
    const label = btn.textContent;
    try {
      const hash = await act([{ c: "vault", fn: "rebalance" }], (m) => (btn.innerHTML = `<span class="spinner"></span> ${m}`));
      toast(`Done. ${txLink(hash)}`, false, 7000);
      await refresh();
      loadFeed();
    } catch (x) {
      toastError(x);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

main().catch((e) => {
  console.error(e);
  toast("Couldn't load the control room.", true, 0);
});
