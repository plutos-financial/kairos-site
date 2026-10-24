// Beta only: the Plutos wallet (save it, send, receive, cash out) and the Apple Pay preview.
//
// The savings page's "Add money" adds test dollars and saves them in one step (app.js). This file's
// "Try Apple Pay" is a preview of the real checkout: it asks our small server
// (netlify/functions/onramp-order) to create a Coinbase onramp order in sandbox mode, then shows
// Coinbase's payment page in a frame. Sandbox orders always succeed and no card is charged, so once
// Coinbase says the payment went through we add the same amount of test dollars (MockUSDC.topUp) to
// the Plutos wallet, ready to save. Coinbase's guest checkout allows $500 a week, which is why it's
// only a preview here.
//
// "Cash out" is simulated: Coinbase has no test mode for cash-outs. The test dollars are sent to a
// burn address, like a real cash-out sends USDC to Coinbase.
import { isAddress, parseUnits } from "viem";
import qrcode from "qrcode-generator";
import { $, state, fmt, short, act, read, friendlyError, esc, txLink, accessToken } from "./core.js";

const BURN = "0x000000000000000000000000000000000000dEaD";
const PAY_ORIGIN = "https://pay.coinbase.com"; // the only page Plutos will show inside "Add money"
const TERMS = {
  guest: "https://www.coinbase.com/legal/guest-checkout/us",
  user: "https://www.coinbase.com/legal/user_agreement",
  privacy: "https://www.coinbase.com/legal/privacy",
};

let ctx; // { wallet(), savings(), refresh(), saveWallet(button, amount) }
let pending = null; // { amount, orderId } while a Coinbase payment is open

export function initBetaWallet(c) {
  ctx = c;
  const bar = document.querySelector(".testnet-bar");
  if (bar) bar.textContent = "Test network. Everything here is free test dollars, and no card is ever charged.";
  $("walletCard").addEventListener("click", (e) => {
    const b = e.target.closest(".wa");
    if (!b) return;
    if (b.dataset.act === "save") ctx.saveWallet(b);
    else open(b.dataset.act);
  });
  $("sheetX").onclick = close;
  $("sheet").addEventListener("click", (e) => e.target === $("sheet") && close());
  addEventListener("keydown", (e) => e.key === "Escape" && !$("sheet").hidden && close());
  addEventListener("message", onCoinbaseMessage);
}

export function renderWallet(wallet, savings) {
  $("walletCard").hidden = wallet === 0n; // only when there's money that isn't saved
  $("walletBal").textContent = fmt(wallet);
}

// ------------------------------------------------------------------ the sheet

/** Opens Add money / Send / Receive / Cash out from elsewhere on the page. */
export const openAction = (kind) => open(kind);

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
  payFrame = null;
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
  return /^https:\/\//.test(u) || (state.cfg?.chainId === 31337 && /^http:\/\/localhost:\d+$/.test(u)) ? u : "";
}

/** Apple Pay goes through the Plutos money server, which needs the email sign-in to know who's paying. */
const canPay = () => Boolean(moneyApi()) && state.mode === "email";

/** Headers for the money server: who's asking, proved by their Coinbase sign-in. */
async function authHeaders() {
  const t = await accessToken();
  if (!t) throw new Error("Sign in with your email to pay with Apple Pay.");
  return { Authorization: `Bearer ${t}` };
}

/** Only ever frame Coinbase's own payment page. */
function safePayLink(link, sandbox) {
  let u;
  try {
    u = new URL(String(link || ""));
  } catch {
    return "";
  }
  const localTest = state.cfg?.chainId === 31337 && u.origin === location.origin; // the local stand-in checkout
  if (u.origin !== PAY_ORIGIN && !localTest) return "";
  if (sandbox) u.searchParams.set("useApplePaySandbox", "true");
  return u.toString();
}

function addForm() {
  const api = canPay();
  if (!api) {
    body(`
      <h2 id="sheetTitle">The Apple Pay checkout</h2>
      <p class="sh-sub">${
        moneyApi()
          ? "The Apple Pay preview needs the email sign-in. You don't need it to try Plutos: Add money adds test dollars straight into your savings."
          : "The Coinbase connection isn't switched on for this site yet. Add money adds test dollars straight into your savings."
      }</p>
      <button id="shDone" class="btn btn-primary btn-lg btn-block" type="button">Got it</button>`);
    $("shDone").onclick = close;
    return;
  }
  body(`
    <h2 id="sheetTitle">Try Apple Pay</h2>
    <p class="sh-sub">This is how adding money works at launch: Apple Pay or a debit card through Coinbase. It's Coinbase's test mode, so your card is never charged and we add test dollars instead. Coinbase allows up to $500 a week here; Add money on the savings page has no card limits.</p>
    ${moneyInput("shAmt", "50")}
    <div class="sh-chips">${[20, 50, 100, 250].map((v) => `<button type="button" class="chip" data-v="${v}">$${v}</button>`).join("")}</div>
    <label class="sh-label" for="shPhone">US mobile number</label>
    <input id="shPhone" type="tel" autocomplete="tel" placeholder="(555) 123-4567" />
    <label class="sh-check"><input type="checkbox" id="shAgree" /> <span>I agree to Coinbase's <a href="${TERMS.guest}" target="_blank" rel="noopener noreferrer">Guest Checkout Terms</a>, <a href="${TERMS.user}" target="_blank" rel="noopener noreferrer">User Agreement</a> and <a href="${TERMS.privacy}" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</span></label>
    <button id="shGo" class="btn btn-primary btn-lg btn-block" type="button">Continue to Apple Pay</button>
    <p class="form-error" id="sheetErr" role="alert"></p>`);
  $("sheetBody").querySelectorAll(".sh-chips .chip").forEach((c) => (c.onclick = () => ($("shAmt").value = c.dataset.v)));
  $("shGo").onclick = startCoinbase;
}

async function startCoinbase() {
  err("");
  const amount = amountFrom("shAmt", 5);
  if (amount === null) return err("Enter at least $5. That's Coinbase's smallest card payment.");
  if (amount > 500_000_000n) return err("Coinbase's checkout allows up to $500 a week. For more, close this and use Add money.");
  const digits = String($("shPhone").value || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) return err("Enter a US mobile number with area code.");
  if (!$("shAgree").checked) return err("Tick the box to agree to Coinbase's terms.");
  await busy($("shGo"), "Talking to Coinbase…", async () => {
    try {
      const r = await fetch(`${moneyApi()}/api/onramp-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify({
          address: state.address,
          amount: (Number(amount) / 1e6).toFixed(2),
          phone: "+1" + digits,
          agreedAt: new Date().toISOString(),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.paymentLink) throw new Error(j.error || `Coinbase didn't start the payment (error ${r.status}).`);
      const link = safePayLink(j.paymentLink, j.sandbox);
      if (!link) throw new Error("That payment link didn't come from Coinbase, so Plutos won't open it.");
      pending = { amount, orderId: String(j.orderId || ""), done: false };
      payView(link);
    } catch (e) {
      console.error(e);
      err(/fetch/i.test(e.message) ? "Couldn't reach the Plutos server. Try again in a moment." : e.message);
    }
  });
}

let payFrame = null; // the Coinbase checkout frame, the only window whose messages count

function payView(link) {
  body(`
    <h2 id="sheetTitle">Pay with Apple Pay</h2>
    <p class="sh-sub">Coinbase test mode: nothing is charged. In Safari you'll see Apple Pay. In other browsers, scan the code with your iPhone.</p>
    <div id="shPayBox"></div>
    <button id="shPaid" class="btn btn-ghost btn-block" type="button">I've finished paying</button>
    <p class="form-error" id="sheetErr" role="alert"></p>`);
  const f = document.createElement("iframe");
  f.className = "sh-pay";
  f.title = "Coinbase checkout";
  f.setAttribute("sandbox", "allow-scripts allow-same-origin"); // what Coinbase asks for, nothing more
  f.setAttribute("referrerpolicy", "no-referrer");
  f.setAttribute("allow", "payment");
  f.src = link; // checked by safePayLink: always https://pay.coinbase.com
  $("shPayBox").replaceWith(f);
  payFrame = f;
  $("shPaid").onclick = checkOrder;
}

function onCoinbaseMessage(e) {
  if (!pending || pending.done) return;
  // Only Coinbase's checkout, in the frame Plutos opened, can say a payment went through.
  const from = state.cfg?.chainId === 31337 ? [PAY_ORIGIN, location.origin] : [PAY_ORIGIN];
  if (!from.includes(e.origin) || !payFrame || e.source !== payFrame.contentWindow) return;
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
  else if (/commit_error|polling_error|polling_failed|session_error|load_error/.test(name)) err(String(d?.data?.errorMessage || "Coinbase couldn't finish the payment. Try again.").slice(0, 200));
}

async function checkOrder() {
  if (!pending) return;
  await busy($("shPaid"), "Checking with Coinbase…", async () => {
    try {
      const r = await fetch(`${moneyApi()}/api/onramp-order?id=${encodeURIComponent(pending.orderId || "")}`, { headers: await authHeaders() });
      const j = await r.json().catch(() => ({}));
      // Sandbox orders always succeed, so only a clear failure stops it there.
      if (/COMPLETED|PROCESSING/.test(j.status || "") || (j.sandbox && !/FAILED/.test(j.status || ""))) return finishAdd();
      err("Coinbase hasn't confirmed the payment yet. Finish it above, then press this again.");
    } catch (e) {
      err(/sign in/i.test(e?.message || "") ? e.message : "Couldn't reach the Plutos server. Try again in a moment.");
    }
  });
}

async function finishAdd() {
  if (!pending || pending.done) return;
  pending.done = true;
  body(`<h2 id="sheetTitle">Payment received</h2><p class="sh-sub"><span class="spinner" aria-hidden="true"></span> Adding ${fmt(pending.amount)} to your Plutos wallet…</p>`);
  await topUp(pending.amount);
}

async function topUp(amount) {
  if (amount === null) return err("Enter an amount of at least $1.");
  try {
    const hash = await act([{ c: "usdc", fn: "topUp", args: [amount] }]);
    await ctx.refresh();
    body(`
      <h2 id="sheetTitle">Added ${fmt(amount)}</h2>
      <p class="sh-sub">It's in your Plutos wallet. Save it to get entries in the next draw. ${txLink(hash)}</p>
      <button id="shSave" class="btn btn-primary btn-lg btn-block" type="button">Save ${fmt(amount)}</button>
      <button id="shDone" class="btn btn-ghost btn-block" type="button">Done</button>`);
    $("shSave").onclick = () => {
      close();
      ctx.saveWallet(document.querySelector('#walletCard [data-act="save"]'), amount);
    };
    $("shDone").onclick = close;
  } catch (e) {
    console.error(e);
    body(`<h2 id="sheetTitle">Add money</h2><p class="form-error" id="sheetErr" role="alert">${esc(friendlyError(e))}</p>`);
  }
}

// ------------------------------------------------------------------ send

function sendForm() {
  body(`
    <h2 id="sheetTitle">Send money</h2>
    <p class="sh-sub">Send USDC from your Plutos wallet to any address on Base. In the beta it's test USDC.</p>
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
    if (amount > ctx.wallet()) return err(`You have ${fmt(ctx.wallet())} in your Plutos wallet.`);
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
    <div class="sh-qr"><svg viewBox="-2 -2 ${n + 4} ${n + 4}" role="img" aria-label="QR code of your address"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#0A0E1A"/></svg></div>
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
    if (amount > ctx.wallet()) return err(`You have ${fmt(ctx.wallet())} in your Plutos wallet. Withdraw from savings first if you need more.`);
    await busy($("shGo"), "Cashing out…", async (status) => {
      try {
        const hash = await act([{ c: "usdc", fn: "transfer", args: [BURN, amount] }], status);
        await ctx.refresh();
        body(`
          <h2 id="sheetTitle">${fmt(amount)} is on its way</h2>
          <ol class="sh-steps">
            <li class="done">Sent from your Plutos wallet ${txLink(hash)}</li>
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
