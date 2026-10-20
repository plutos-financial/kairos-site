// Beta only: the Kairos wallet. Add money (Coinbase Apple Pay, test mode), send, receive, cash out.
//
// "Add money" asks our small server (netlify/functions/onramp-order) to create a Coinbase onramp order
// in sandbox mode, then shows Coinbase's payment page in a frame. Sandbox orders always succeed and
// no card is charged, so once Coinbase says the payment went through we add the same amount of test
// dollars (MockUSDC.topUp). Without the server, Add money just adds test dollars.
//
// "Cash out" is simulated: Coinbase has no test mode for cash-outs. The test dollars are sent to a
// burn address, like a real cash-out sends USDC to Coinbase.
import { isAddress, parseUnits } from "viem";
import qrcode from "qrcode-generator";
import { $, state, fmt, short, act, read, friendlyError, toast, txLink } from "./core.js";

const BURN = "0x000000000000000000000000000000000000dEaD";
const TERMS = {
  guest: "https://www.coinbase.com/legal/guest-checkout/us",
  user: "https://www.coinbase.com/legal/user_agreement",
  privacy: "https://www.coinbase.com/legal/privacy",
};

let ctx; // { wallet(), savings(), refresh(), fillDeposit(amount) }
let pending = null; // { amount, orderId } while a Coinbase payment is open
let symbol = "kUSD";

export function initBetaWallet(c) {
  ctx = c;
  $("walletCard").hidden = false;
  $("betaTag").hidden = false;
  const bar = document.querySelector(".testnet-bar");
  if (bar) bar.textContent = "Beta on the test network. Coinbase is in test mode, so no card is ever charged.";
  $("walletCard").addEventListener("click", (e) => {
    const b = e.target.closest(".wa");
    if (b) open(b.dataset.act);
  });
  $("sheetX").onclick = close;
  $("sheet").addEventListener("click", (e) => e.target === $("sheet") && close());
  addEventListener("keydown", (e) => e.key === "Escape" && !$("sheet").hidden && close());
  addEventListener("message", onCoinbaseMessage);
  read("vault", "symbol").then((x) => (symbol = x)).catch(() => {});
}

export function renderWallet(wallet, savings) {
  $("walletBal").textContent = fmt(wallet);
  const line = $("tokensLine");
  const tokens = Number(savings) / 1e6;
  line.hidden = savings === 0n;
  line.textContent = `${tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol} savings tokens · each one is worth $1`;
}

// ------------------------------------------------------------------ the sheet

function open(kind) {
  pending = null;
  ({ add: addForm, send: sendForm, receive: receiveView, cashout: cashForm })[kind]?.();
  $("sheet").hidden = false;
  $("sheet").querySelector("input, button:not(.sheet-x)")?.focus();
}

function close() {
  $("sheet").hidden = true;
  $("sheetBody").innerHTML = "";
  pending = null;
}

const body = (html) => ($("sheetBody").innerHTML = html);
const err = (m) => {
  const el = $("sheetErr");
  if (el) el.textContent = m || "";
};

function moneyInput(id, value, max) {
  return `<label class="sh-label" for="${id}">Amount</label>
    <div class="sh-money"><span>$</span><input id="${id}" inputmode="decimal" autocomplete="off" value="${value}" /></div>
    ${max ? `<button type="button" class="link-btn sh-max" data-max="${max}">Use all of it (${fmt(max)})</button>` : ""}`;
}

function wireMax() {
  $("sheetBody").querySelectorAll(".sh-max").forEach((b) => {
    b.onclick = () => {
      const inp = $("sheetBody").querySelector(".sh-money input");
      inp.value = (Number(BigInt(b.dataset.max)) / 1e6).toFixed(2);
    };
  });
}

function amountFrom(id, min = 0.01) {
  const raw = String($(id).value || "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(raw) || Number(raw) < min) return null;
  return parseUnits(raw, 6);
}

async function busy(btn, text, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${text}`;
  try {
    return await fn((m) => (btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${m}`));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ------------------------------------------------------------------ add money

function moneyApi() {
  const u = String(state.appCfg.moneyApi || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(u) ? u : "";
}

function addForm() {
  const api = moneyApi();
  body(`
    <h2 id="sheetTitle">Add money</h2>
    <p class="sh-sub">${
      api
        ? "Pay with Apple Pay through Coinbase. This is Coinbase's test mode: your card is never charged, and we add test dollars instead."
        : "The Coinbase connection isn't switched on for this site yet, so this adds test dollars straight away."
    }</p>
    ${moneyInput("shAmt", "50")}
    <div class="sh-chips">${[20, 50, 100, 250].map((v) => `<button type="button" class="chip" data-v="${v}">$${v}</button>`).join("")}</div>
    ${
      api
        ? `<label class="sh-label" for="shPhone">US mobile number</label>
           <input id="shPhone" type="tel" autocomplete="tel" placeholder="(555) 123-4567" />
           <label class="sh-check"><input type="checkbox" id="shAgree" /> <span>I agree to Coinbase's <a href="${TERMS.guest}" target="_blank" rel="noopener">Guest Checkout Terms</a>, <a href="${TERMS.user}" target="_blank" rel="noopener">User Agreement</a> and <a href="${TERMS.privacy}" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>`
        : ""
    }
    <button id="shGo" class="btn btn-primary btn-lg btn-block" type="button">${api ? "Continue to Apple Pay" : "Add test dollars"}</button>
    <p class="form-error" id="sheetErr" role="alert"></p>`);
  $("sheetBody").querySelectorAll(".sh-chips .chip").forEach((c) => (c.onclick = () => ($("shAmt").value = c.dataset.v)));
  $("shGo").onclick = api ? startCoinbase : () => topUp(amountFrom("shAmt", 1));
}

async function startCoinbase() {
  err("");
  const amount = amountFrom("shAmt", 5);
  if (amount === null) return err("Enter at least $5. That's Coinbase's smallest card payment.");
  if (amount > 500_000_000n) return err("Coinbase guest checkout allows up to $500 a week.");
  const digits = String($("shPhone").value || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) return err("Enter a US mobile number with area code.");
  if (!$("shAgree").checked) return err("Tick the box to agree to Coinbase's terms.");
  await busy($("shGo"), "Talking to Coinbase…", async () => {
    try {
      const r = await fetch(`${moneyApi()}/api/onramp-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: state.address,
          amount: (Number(amount) / 1e6).toFixed(2),
          email: state.email || undefined,
          phone: "+1" + digits,
          agreedAt: new Date().toISOString(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.paymentLink) throw new Error(j.error || `Coinbase didn't start the payment (error ${r.status}).`);
      pending = { amount, orderId: j.orderId, done: false };
      let link = j.paymentLink;
      if (j.sandbox) link += (link.includes("?") ? "&" : "?") + "useApplePaySandbox=true";
      payView(link);
    } catch (e) {
      console.error(e);
      err(/fetch/i.test(e.message) ? "Couldn't reach the Kairos server. Try again in a moment." : e.message);
    }
  });
}

function payView(link) {
  body(`
    <h2 id="sheetTitle">Pay with Apple Pay</h2>
    <p class="sh-sub">Coinbase test mode: nothing is charged. In Safari you'll see Apple Pay. In other browsers, scan the code with your iPhone.</p>
    <iframe class="sh-pay" src="${link.replace(/"/g, "&quot;")}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" allow="payment" title="Coinbase checkout"></iframe>
    <button id="shPaid" class="btn btn-ghost btn-block" type="button">I've finished paying</button>
    <p class="form-error" id="sheetErr" role="alert"></p>`);
  $("shPaid").onclick = checkOrder;
}

function onCoinbaseMessage(e) {
  if (!pending || pending.done) return;
  let host = "";
  try {
    host = new URL(e.origin).hostname;
  } catch {}
  if (!/(^|\.)coinbase\.com$/.test(host)) return;
  let d = e.data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      d = { eventName: d };
    }
  }
  const name = String(d?.eventName || d?.event || d?.name || d?.type || "");
  if (/commit_success|polling_success/.test(name)) finishAdd();
  else if (/commit_error|polling_error|polling_failed|session_error|load_error/.test(name)) err(d?.data?.errorMessage || "Coinbase couldn't finish the payment. Try again.");
}

async function checkOrder() {
  if (!pending) return;
  await busy($("shPaid"), "Checking with Coinbase…", async () => {
    try {
      const r = await fetch(`${moneyApi()}/api/onramp-order?id=${encodeURIComponent(pending.orderId || "")}`);
      const j = await r.json().catch(() => ({}));
      // Sandbox orders always succeed, so only a clear failure stops it there.
      if (/COMPLETED|PROCESSING/.test(j.status || "") || (j.sandbox && !/FAILED/.test(j.status || ""))) return finishAdd();
      err("Coinbase hasn't confirmed the payment yet. Finish it above, then press this again.");
    } catch {
      err("Couldn't reach the Kairos server. Try again in a moment.");
    }
  });
}

async function finishAdd() {
  if (!pending || pending.done) return;
  pending.done = true;
  body(`<h2 id="sheetTitle">Payment received</h2><p class="sh-sub"><span class="spinner" aria-hidden="true"></span> Adding ${fmt(pending.amount)} to your Kairos wallet…</p>`);
  await topUp(pending.amount);
}

async function topUp(amount) {
  if (amount === null) return err("Enter an amount of at least $1.");
  try {
    const hash = await act([{ c: "usdc", fn: "topUp", args: [amount] }]);
    await ctx.refresh();
    body(`
      <h2 id="sheetTitle">Added ${fmt(amount)}</h2>
      <p class="sh-sub">It's in your Kairos wallet. Save it to get entries in the next draw. ${txLink(hash)}</p>
      <button id="shSave" class="btn btn-primary btn-lg btn-block" type="button">Save ${fmt(amount)}</button>
      <button id="shDone" class="btn btn-ghost btn-block" type="button">Done</button>`);
    $("shSave").onclick = () => {
      close();
      ctx.fillDeposit(amount);
    };
    $("shDone").onclick = close;
  } catch (e) {
    console.error(e);
    body(`<h2 id="sheetTitle">Add money</h2><p class="form-error" id="sheetErr" role="alert">${friendlyError(e)}</p>`);
  }
}

// ------------------------------------------------------------------ send

function sendForm() {
  body(`
    <h2 id="sheetTitle">Send money</h2>
    <p class="sh-sub">Send USDC from your Kairos wallet to any address on Base. In the beta it's test USDC.</p>
    <label class="sh-label" for="shTo">To</label>
    <input id="shTo" autocomplete="off" spellcheck="false" placeholder="0x…" />
    ${moneyInput("shAmt", "10", ctx.wallet())}
    <button id="shGo" class="btn btn-primary btn-lg btn-block" type="button">Send</button>
    <p class="form-error" id="sheetErr" role="alert"></p>`);
  wireMax();
  $("shGo").onclick = async () => {
    err("");
    const to = String($("shTo").value || "").trim();
    if (!isAddress(to)) return err("That isn't a valid address. It starts with 0x and has 42 characters.");
    if (to.toLowerCase() === state.address.toLowerCase()) return err("That's your own address.");
    const amount = amountFrom("shAmt");
    if (amount === null) return err("Enter an amount.");
    if (amount > ctx.wallet()) return err(`You have ${fmt(ctx.wallet())} in your Kairos wallet.`);
    await busy($("shGo"), "Sending…", async (status) => {
      try {
        const hash = await act([{ c: "usdc", fn: "transfer", args: [to, amount] }], status);
        await ctx.refresh();
        body(`<h2 id="sheetTitle">Sent ${fmt(amount)}</h2><p class="sh-sub">On its way to ${short(to)}. Transfers on Base land in a few seconds. ${txLink(hash)}</p>
          <button id="shDone" class="btn btn-primary btn-lg btn-block" type="button">Done</button>`);
        $("shDone").onclick = close;
      } catch (e) {
        console.error(e);
        err(friendlyError(e));
      }
    });
  };
}

// ------------------------------------------------------------------ receive

function receiveView() {
  const q = qrcode(0, "M");
  q.addData(state.address);
  q.make();
  const n = q.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  body(`
    <h2 id="sheetTitle">Receive money</h2>
    <p class="sh-sub">Anyone can send USDC on Base to this address. In the beta, only send test USDC.</p>
    <div class="sh-qr"><svg viewBox="-2 -2 ${n + 4} ${n + 4}" role="img" aria-label="QR code of your address"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#050506"/></svg></div>
    <p class="sh-addr" id="shAddr">${state.address}</p>
    <button id="shCopy" class="btn btn-primary btn-lg btn-block" type="button">Copy address</button>`);
  $("shCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.address);
      $("shCopy").textContent = "Copied";
    } catch {
      getSelection().selectAllChildren($("shAddr"));
      $("shCopy").textContent = "Selected, press Cmd+C to copy";
    }
  };
}

// ------------------------------------------------------------------ cash out (simulated)

function cashForm() {
  body(`
    <h2 id="sheetTitle">Cash out to your bank</h2>
    <p class="sh-sub">At launch, cash-outs go through Coinbase to the bank account linked there, usually in 1 to 3 business days. Coinbase has no test mode for cash-outs, so the beta simulates it: the test dollars leave your wallet, but no bank transfer happens.</p>
    ${moneyInput("shAmt", "10", ctx.wallet())}
    <button id="shGo" class="btn btn-primary btn-lg btn-block" type="button">Cash out (test)</button>
    <p class="form-error" id="sheetErr" role="alert"></p>`);
  wireMax();
  $("shGo").onclick = async () => {
    err("");
    const amount = amountFrom("shAmt", 1);
    if (amount === null) return err("Enter at least $1.");
    if (amount > ctx.wallet()) return err(`You have ${fmt(ctx.wallet())} in your Kairos wallet. Withdraw from savings first if you need more.`);
    await busy($("shGo"), "Cashing out…", async (status) => {
      try {
        const hash = await act([{ c: "usdc", fn: "transfer", args: [BURN, amount] }], status);
        await ctx.refresh();
        body(`
          <h2 id="sheetTitle">${fmt(amount)} is on its way</h2>
          <ol class="sh-steps">
            <li class="done">Sent from your Kairos wallet ${txLink(hash)}</li>
            <li class="done">Bank transfer started <span class="tiny">(simulated in the beta)</span></li>
            <li>Arrives in your bank in 1 to 3 business days</li>
          </ol>
          <button id="shDone" class="btn btn-primary btn-lg btn-block" type="button">Done</button>`);
        $("shDone").onclick = close;
      } catch (e) {
        console.error(e);
        err(friendlyError(e));
      }
    });
  };
}
