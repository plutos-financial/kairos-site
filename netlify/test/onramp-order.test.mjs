import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ORIGIN = "https://plutos-financial.github.io";
process.env.ALLOWED_ORIGINS = `${ORIGIN},http://localhost:8888`;
process.env.CDP_API_KEY_ID = "test-key-id";
process.env.CDP_API_KEY_SECRET = "super-secret-value";

let n = 0;
async function fresh() {
  // a fresh module each time, so the rate limiter starts empty
  return (await import(`../functions/onramp-order.mjs?t=${++n}`)).handler;
}
const goodBody = () => ({
  address: "0x63c8000000000000000000000000000000000542",
  amount: "50.00",
  phone: "+15551234567",
  email: "ramy@example.com",
  agreedAt: new Date().toISOString(),
});
const post = (body, origin = ORIGIN) =>
  new Request("https://kairos-money.netlify.app/api/onramp-order", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const okCoinbase = (capture) => async (url, init) => {
  capture?.push({ url, init });
  return new Response(JSON.stringify({ order: { orderId: "ord_123456", status: "ONRAMP_ORDER_STATUS_PENDING_PAYMENT" }, paymentLink: { url: "https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1" } }), { status: 201 });
};
const deps = (fetch) => ({ fetch, generateJwt: async (o) => `jwt-for-${o.requestMethod}-${o.requestPath}` });

test("creates a sandbox Apple Pay order", async () => {
  const handler = await fresh();
  const calls = [];
  const r = await handler(post(goodBody()), { ip: "1.2.3.4" }, deps(okCoinbase(calls)));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.paymentLink, "https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1");
  assert.equal(j.orderId, "ord_123456");
  assert.equal(j.sandbox, true);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, "https://api.cdp.coinbase.com/platform/v2/onramp/orders");
  assert.equal(calls[0].init.headers.Authorization, "Bearer jwt-for-POST-/platform/v2/onramp/orders");
  assert.ok(sent.partnerUserRef.startsWith("sandbox-"));
  assert.equal(sent.paymentMethod, "GUEST_CHECKOUT_APPLE_PAY");
  assert.equal(sent.purchaseCurrency, "USDC");
  assert.equal(sent.destinationNetwork, "base");
  assert.equal(sent.domain, "plutos-financial.github.io");
  assert.equal(sent.clientIp, "1.2.3.4");
});

test("rejects bad input", async () => {
  const handler = await fresh();
  for (const patch of [{ address: "0x123" }, { amount: "0" }, { amount: "4.99" }, { amount: "501" }, { amount: "abc" }, { amount: "1e3" }, { phone: "5551234567" }, { agreedAt: "2020-01-01T00:00:00Z" }, { email: "nope" }]) {
    const r = await handler(post({ ...goodBody(), ...patch }), { ip: "5.5.5.5" }, deps(okCoinbase()));
    assert.equal(r.status, 400, JSON.stringify(patch));
  }
});

test("refuses sites that aren't on the list", async () => {
  const handler = await fresh();
  const r = await handler(post(goodBody(), "https://evil.example"), { ip: "1.1.1.1" }, deps(okCoinbase()));
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("answers the browser's preflight", async () => {
  const handler = await fresh();
  const r = await handler(new Request("https://x/api/onramp-order", { method: "OPTIONS", headers: { origin: ORIGIN } }), {}, deps(okCoinbase()));
  assert.equal(r.status, 204);
  assert.match(r.headers.get("access-control-allow-methods"), /POST/);
});

test("rate limits after 10 tries a minute", async () => {
  const handler = await fresh();
  let last;
  for (let i = 0; i < 11; i++) last = await handler(post(goodBody()), { ip: "9.9.9.9" }, deps(okCoinbase()));
  assert.equal(last.status, 429);
});

test("a Coinbase failure never leaks the secret", async () => {
  const handler = await fresh();
  const bad = async () => new Response(JSON.stringify({ errorType: "internal", errorMessage: "invalid jwt for key test-key-id" }), { status: 500 });
  const r = await handler(post(goodBody()), { ip: "2.2.2.2" }, deps(bad));
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.ok(!text.includes("super-secret-value") && !text.includes("test-key-id") && !/jwt/i.test(text), text);
});

test("passes on Coinbase's plain reasons, like limits", async () => {
  const handler = await fresh();
  const limit = async () => new Response(JSON.stringify({ errorType: "guest_transaction_limit", errorMessage: "Weekly limit reached" }), { status: 400 });
  const r = await handler(post(goodBody()), { ip: "3.3.3.3" }, deps(limit));
  assert.equal((await r.json()).error, "Coinbase said: Weekly limit reached");
});

test("order status", async () => {
  const handler = await fresh();
  const status = async (url) => new Response(JSON.stringify({ order: { status: "ONRAMP_ORDER_STATUS_COMPLETED" } }), { status: 200 });
  const r = await handler(new Request("https://x/api/onramp-order?id=ord_123456", { headers: { origin: ORIGIN } }), { ip: "4.4.4.4" }, deps(status));
  assert.deepEqual(await r.json(), { status: "COMPLETED", sandbox: true });
  const bad = await handler(new Request("https://x/api/onramp-order?id=../../x", { headers: { origin: ORIGIN } }), { ip: "4.4.4.4" }, deps(status));
  assert.equal(bad.status, 400);
});

test("says clearly when the API key is missing", async () => {
  const handler = await fresh();
  const saved = process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_API_KEY_SECRET;
  const r = await handler(post(goodBody()), { ip: "6.6.6.6" }, deps(okCoinbase()));
  process.env.CDP_API_KEY_SECRET = saved;
  assert.equal(r.status, 503);
});
