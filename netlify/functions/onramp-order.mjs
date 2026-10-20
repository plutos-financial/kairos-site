// Kairos money server: creates a Coinbase onramp order (Apple Pay) for the beta.
//
//   POST /api/onramp-order   { address, amount, phone, email?, agreedAt }  -> { orderId, paymentLink, sandbox }
//   GET  /api/onramp-order?id=<orderId>                                     -> { status, sandbox }
//
// Test mode only: every order is a Coinbase *sandbox* order ("sandbox-" partnerUserRef), so cards are
// never charged and no money moves. Real payments also need phone verification by SMS and Coinbase's
// production approval, which this server doesn't do, so it refuses to run without sandbox mode.
//
// Environment variables (Netlify: Site configuration -> Environment variables):
//   CDP_API_KEY_ID       Coinbase Developer Platform secret API key id
//   CDP_API_KEY_SECRET   the key's secret (mark it secret in Netlify; never put it in the website)
//   ALLOWED_ORIGINS      comma-separated sites allowed to call this, e.g. https://plutos-financial.github.io
const HOST = "api.cdp.coinbase.com";
const PATH = "/platform/v2/onramp/orders";
const MIN = 5; // Coinbase guest checkout minimum, USD
const MAX = 500; // guest checkout weekly limit, USD
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;

const hits = new Map(); // ip -> recent request times (per server instance; fine for a beta)

function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

const reply = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/** Coinbase's own message when it's safe and useful to show (limits, unsupported region), never secrets. */
function coinbaseReason(j) {
  const m = String(j?.errorMessage || j?.message || "").trim();
  if (!m || m.length > 200 || /key|jwt|token|secret|auth/i.test(m)) return "";
  return m;
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
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (limited(context.ip || "unknown")) return reply(429, { error: "Too many tries. Wait a minute and try again." }, cors);

  const keyId = process.env.CDP_API_KEY_ID;
  const keySecret = process.env.CDP_API_KEY_SECRET;
  if (!keyId || !keySecret) return reply(503, { error: "The money server isn't set up yet: it's missing the Coinbase API key." }, cors);

  const doFetch = deps.fetch || fetch;
  const sign = deps.generateJwt || (await import("@coinbase/cdp-sdk/auth")).generateJwt;
  const auth = async (method, path) =>
    `Bearer ${await sign({ apiKeyId: keyId, apiKeySecret: keySecret, requestMethod: method, requestHost: HOST, requestPath: path, expiresIn: 120 })}`;

  // ---- status of an order
  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!/^[A-Za-z0-9_-]{6,100}$/.test(id)) return reply(400, { error: "Missing or bad order id." }, cors);
    const path = `${PATH}/${id}`;
    try {
      const r = await doFetch(`https://${HOST}${path}`, { headers: { Authorization: await auth("GET", path) } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return reply(200, { status: "UNKNOWN", sandbox: true }, cors);
      return reply(200, { status: String(j?.order?.status || j?.status || "UNKNOWN").replace("ONRAMP_ORDER_STATUS_", ""), sandbox: true }, cors);
    } catch {
      return reply(200, { status: "UNKNOWN", sandbox: true }, cors);
    }
  }

  if (req.method !== "POST") return reply(405, { error: "Use POST." }, cors);

  // ---- create an order
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return reply(400, { error: "Send JSON." }, cors);
  const address = String(b.address || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return reply(400, { error: "That isn't a valid wallet address." }, cors);
  const amountStr = String(b.amount ?? "");
  const amount = Number(amountStr);
  if (!/^\d+(\.\d{1,2})?$/.test(amountStr) || !(amount >= MIN && amount <= MAX))
    return reply(400, { error: `Enter an amount between $${MIN} and $${MAX}.` }, cors);
  const phone = String(b.phone || "");
  if (!/^\+1\d{10}$/.test(phone)) return reply(400, { error: "Enter a US mobile number." }, cors);
  const email = String(b.email || "beta@sandbox.test");
  if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/.test(email)) return reply(400, { error: "That email doesn't look right." }, cors);
  const agreedAt = new Date(String(b.agreedAt || ""));
  if (isNaN(agreedAt) || Math.abs(Date.now() - agreedAt.getTime()) > 15 * 60_000)
    return reply(400, { error: "Please agree to Coinbase's terms first." }, cors);

  const order = {
    paymentAmount: amount.toFixed(2),
    paymentCurrency: "USD",
    purchaseCurrency: "USDC",
    paymentMethod: "GUEST_CHECKOUT_APPLE_PAY",
    destinationAddress: address,
    destinationNetwork: "base",
    partnerUserRef: `sandbox-${address.toLowerCase()}`, // sandbox: always succeeds, never charges a card
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
    if (!r.ok || !j?.paymentLink?.url) {
      console.error("Coinbase onramp order failed", r.status, j?.errorType || "", coinbaseReason(j));
      const why = coinbaseReason(j);
      return reply(502, { error: why ? `Coinbase said: ${why}` : "Coinbase couldn't start the payment. Try again in a minute." }, cors);
    }
    return reply(200, { orderId: j.order?.orderId || "", status: j.order?.status || "", paymentLink: j.paymentLink.url, sandbox: true }, cors);
  } catch (e) {
    console.error("Couldn't reach Coinbase", e?.message);
    return reply(502, { error: "Couldn't reach Coinbase. Try again in a minute." }, cors);
  }
}

export default (req, context) => handler(req, context);

export const config = { path: "/api/onramp-order" };
