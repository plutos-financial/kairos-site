// Kairos money server: creates a Coinbase onramp order (Apple Pay) for the Kairos app.
//
//   POST /api/onramp-order   { address, amount, phone, agreedAt }  -> { orderId, paymentLink, sandbox }
//   GET  /api/onramp-order?id=<orderId>                            -> { status, sandbox }
//
// Both need the saver's Coinbase sign-in: the app sends "Authorization: Bearer <access token>" from
// the Coinbase embedded wallet. The server asks Coinbase who that token belongs to, and only starts a
// payment into one of that person's own accounts. So nobody can use this server (or Kairos's Coinbase
// quota) without signing in to Kairos, and nobody can point a payment at someone else's address.
//
// Test mode only: every order is a Coinbase *sandbox* order ("sandbox-" partnerUserRef), so cards are
// never charged and no money moves. Real payments also need phone verification by SMS and Coinbase's
// production approval, which this server doesn't do, so it refuses to run without sandbox mode.
//
// Environment variables (Netlify: Site configuration -> Environment variables):
//   CDP_API_KEY_ID       Coinbase Developer Platform secret API key id
//   CDP_API_KEY_SECRET   the key's secret (mark it secret in Netlify; never put it in the website)
//   ALLOWED_ORIGINS      comma-separated sites allowed to call this, e.g. https://plutos-financial.github.io
//   SIGN_IN_REQUIRED     optional. "false" switches off the sign-in check (only for troubleshooting).
const HOST = "api.cdp.coinbase.com";
const PATH = "/platform/v2/onramp/orders";
const VALIDATE = "/platform/v2/end-users/auth/validate-token";
const MIN = 5; // Coinbase guest checkout minimum, USD
const MAX = 500; // guest checkout weekly limit, USD
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10; // any request, per IP
const ORDERS_PER_USER = 5; // new payments per signed-in saver
const ORDER_WINDOW_MS = 10 * 60_000;

// Per server instance, which is enough to stop a burst. (A shared store would be needed for real money.)
const hits = new Map(); // ip -> recent request times
const orders = new Map(); // user id -> recent order times

function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function tooMany(map, key, max, windowMs) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  map.set(key, recent);
  if (map.size > 5000) map.delete(map.keys().next().value); // keep memory bounded
  return recent.length > max;
}

const SECURITY = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...SECURITY, ...headers } });

/** Coinbase's own message when it's safe and useful to show (limits, unsupported region), never secrets. */
function coinbaseReason(j) {
  const m = String(j?.errorMessage || j?.message || "").trim();
  if (!m || m.length > 200 || /key|jwt|token|secret|auth/i.test(m)) return "";
  return m.replace(/[<>]/g, "");
}

const lower = (a) => String(a || "").toLowerCase();

/** Every address that belongs to the signed-in saver: smart accounts and the keys that own them. */
function addressesOf(user) {
  const out = new Set();
  for (const a of user?.evmSmartAccounts || []) out.add(lower(a));
  for (const a of user?.evmAccounts || []) out.add(lower(a));
  for (const o of user?.evmSmartAccountObjects || []) out.add(lower(o?.address));
  for (const o of user?.evmAccountObjects || []) out.add(lower(o?.address));
  out.delete("");
  return out;
}

function emailOf(user) {
  const m = user?.authenticationMethods;
  const list = Array.isArray(m) ? m : m ? Object.values(m) : [];
  for (const x of list) if (x && typeof x.email === "string") return x.email;
  return "";
}

/**
 * The request handler. `deps` lets tests swap in a fake JWT signer and fetch.
 */
export async function handler(req, context = {}, deps = {}) {
  const origin = (req.headers.get("origin") || "").replace(/\/+$/, "");
  if (!origin || !allowedOrigins().includes(origin)) return reply(403, { error: "This website isn't allowed to use the Kairos money server." });
  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Cache-Control": "no-store" } });
  if (tooMany(hits, context.ip || "unknown", MAX_PER_WINDOW, WINDOW_MS)) return reply(429, { error: "Too many tries. Wait a minute and try again." }, cors);
  if (req.method !== "GET" && req.method !== "POST") return reply(405, { error: "Use POST." }, cors);

  const keyId = process.env.CDP_API_KEY_ID;
  const keySecret = process.env.CDP_API_KEY_SECRET;
  if (!keyId || !keySecret) return reply(503, { error: "The money server isn't set up yet: it's missing the Coinbase API key." }, cors);

  const doFetch = deps.fetch || fetch;
  const sign = deps.generateJwt || (await import("@coinbase/cdp-sdk/auth")).generateJwt;
  const auth = async (method, path) =>
    `Bearer ${await sign({ apiKeyId: keyId, apiKeySecret: keySecret, requestMethod: method, requestHost: HOST, requestPath: path, expiresIn: 120 })}`;

  // ---- who is asking? (their Coinbase sign-in, checked with Coinbase)
  const required = String(process.env.SIGN_IN_REQUIRED ?? "true").toLowerCase() !== "false";
  let user = null;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (required) {
    if (!token || token.length > 8192 || !/^[A-Za-z0-9._~+/=-]+$/.test(token))
      return reply(401, { error: "Sign in to Kairos with your email first.", code: "signin" }, cors);
    try {
      const r = await doFetch(`https://${HOST}${VALIDATE}`, {
        method: "POST",
        headers: { Authorization: await auth("POST", VALIDATE), "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error("Sign-in check failed", r.status, j?.errorType || "");
        if (r.status === 401 || r.status === 404 || j?.errorType === "unauthorized" || j?.errorType === "not_found")
          return reply(401, { error: "Your sign-in has expired. Sign out, sign back in, and try again.", code: "signin" }, cors);
        return reply(502, { error: "Couldn't check your sign-in with Coinbase. Try again in a minute.", code: String(j?.errorType || r.status).slice(0, 40) }, cors);
      }
      user = j;
    } catch (e) {
      console.error("Couldn't reach Coinbase for the sign-in check", e?.message);
      return reply(502, { error: "Couldn't reach Coinbase. Try again in a minute." }, cors);
    }
  }
  const mine = user ? addressesOf(user) : null;

  // ---- status of an order
  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) return reply(400, { error: "Missing or bad order id." }, cors);
    const path = `${PATH}/${id}`;
    try {
      const r = await doFetch(`https://${HOST}${path}`, { headers: { Authorization: await auth("GET", path) } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return reply(200, { status: "UNKNOWN", sandbox: true }, cors);
      const order = j?.order || j;
      // Only the saver the payment is for can look it up.
      if (mine && order?.destinationAddress && !mine.has(lower(order.destinationAddress))) return reply(404, { error: "No such order." }, cors);
      return reply(200, { status: String(order?.status || "UNKNOWN").replace("ONRAMP_ORDER_STATUS_", "").slice(0, 40), sandbox: true }, cors);
    } catch {
      return reply(200, { status: "UNKNOWN", sandbox: true }, cors);
    }
  }

  // ---- create an order
  const raw = await req.text().catch(() => "");
  if (raw.length > 4000) return reply(413, { error: "That request is too big." }, cors);
  let b = null;
  try {
    b = JSON.parse(raw);
  } catch {}
  if (!b || typeof b !== "object" || Array.isArray(b)) return reply(400, { error: "Send JSON." }, cors);
  const address = String(b.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return reply(400, { error: "That isn't a valid wallet address." }, cors);
  if (mine && !mine.has(lower(address))) return reply(403, { error: "Payments can only go to your own Kairos account." }, cors);
  const amountStr = String(b.amount ?? "");
  const amount = Number(amountStr);
  if (!/^\d+(\.\d{1,2})?$/.test(amountStr) || !(amount >= MIN && amount <= MAX))
    return reply(400, { error: `Enter an amount between $${MIN} and $${MAX}.` }, cors);
  const phone = String(b.phone || "");
  if (!/^\+1[2-9]\d{9}$/.test(phone)) return reply(400, { error: "Enter a US mobile number." }, cors);
  // The email comes from the sign-in, not from the page.
  const email = (user && emailOf(user)) || (required ? "" : String(b.email || "beta@sandbox.test"));
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/.test(email)) return reply(400, { error: "Your account needs an email address. Sign in with email." }, cors);
  const agreedAt = new Date(String(b.agreedAt || ""));
  if (isNaN(agreedAt) || Math.abs(Date.now() - agreedAt.getTime()) > 15 * 60_000)
    return reply(400, { error: "Please agree to Coinbase's terms first." }, cors);
  if (tooMany(orders, user?.userId || lower(address), ORDERS_PER_USER, ORDER_WINDOW_MS))
    return reply(429, { error: "That's a lot of payments in a row. Wait 10 minutes and try again." }, cors);

  const order = {
    paymentAmount: amount.toFixed(2),
    paymentCurrency: "USD",
    purchaseCurrency: "USDC",
    paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
    destinationAddress: address,
    destinationNetwork: "base",
    partnerUserRef: `sandbox-${(user?.userId || address.toLowerCase()).slice(0, 100)}`, // sandbox: always succeeds, never charges a card
    email,
    phoneNumber: phone,
    phoneNumberVerifiedAt: new Date().toISOString(), // sandbox accepts any number; real money needs SMS verification
    agreementAcceptedAt: agreedAt.toISOString(),
    domain: new URL(origin).hostname,
    ...(context.ip ? { clientIp: context.ip } : {}),
  };

  try {
    const r = await doFetch(`https://${HOST}${PATH}`, {
      method: "POST",
      headers: { Authorization: await auth("POST", PATH), "Content-Type": "application/json" },
      body: JSON.stringify(order),
    });
    const j = await r.json().catch(() => ({}));
    const link = String(j?.paymentLink?.url || "");
    let host = "";
    try {
      const u = new URL(link);
      if (u.protocol === "https:") host = u.hostname;
    } catch {}
    if (!r.ok || host !== "pay.coinbase.com") {
      console.error("Coinbase onramp order failed", r.status, j?.errorType || "", coinbaseReason(j));
      const why = coinbaseReason(j);
      return reply(502, { error: why ? `Coinbase said: ${why}` : "Coinbase couldn't start the payment. Try again in a minute." }, cors);
    }
    return reply(200, { orderId: String(j.order?.orderId || ""), status: String(j.order?.status || ""), paymentLink: link, sandbox: true }, cors);
  } catch (e) {
    console.error("Couldn't reach Coinbase", e?.message);
    return reply(502, { error: "Couldn't reach Coinbase. Try again in a minute." }, cors);
  }
}

export default (req, context) => handler(req, context);

export const config = { path: "/api/onramp-order" };
