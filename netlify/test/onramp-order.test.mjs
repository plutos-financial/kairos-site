import { test } from "node:test";
import assert from "node:assert/strict";

const ORIGIN = "https://plutos-financial.github.io";
process.env.ALLOWED_ORIGINS = `${ORIGIN},http://localhost:8888`;
process.env.CDP_API_KEY_ID = "test-key-id";
process.env.CDP_API_KEY_SECRET = "super-secret-value";

const ME = "0x63c8000000000000000000000000000000000542";
const OWNER_KEY = "0x1111000000000000000000000000000000000001";
const SOMEONE_ELSE = "0x9999000000000000000000000000000000000999";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJl";

let n = 0;
async function fresh() {
  // a fresh module each time, so the rate limiters start empty
  return (await import(`../functions/onramp-order.mjs?t=${++n}`)).handler;
}
const goodBody = () => ({ address: ME, amount: "50.00", phone: "+15551234567", agreedAt: new Date().toISOString() });
const post = (body, { origin = ORIGIN, token = TOKEN } = {}) =>
  new Request("https://kairos-money.netlify.app/api/onramp-order", {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const get = (id, token = TOKEN) =>
  new Request(`https://x/api/onramp-order?id=${id}`, { headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

const endUser = {
  userId: "user-123",
  authenticationMethods: [{ type: "email", email: "saver@example.com" }],
  evmAccounts: [OWNER_KEY],
  evmSmartAccounts: [ME],
};

/** A fake Coinbase: checks sign-ins, creates orders, answers order status. */
function coinbase({ calls = [], validate, order, status } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/v2/end-users/auth/validate-token")) {
      if (validate) return validate(JSON.parse(init.body));
      const ok = JSON.parse(init.body).accessToken === TOKEN;
      return ok ? Response.json(endUser) : Response.json({ errorType: "unauthorized", errorMessage: "invalid token" }, { status: 401 });
    }
    if (init.method === "POST")
      return order ? order() : Response.json({ order: { orderId: "ord_123456", status: "ONRAMP_ORDER_STATUS_PENDING_PAYMENT" }, paymentLink: { url: "https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1" } }, { status: 201 });
    return status ? status() : Response.json({ order: { status: "ONRAMP_ORDER_STATUS_COMPLETED", destinationAddress: ME } });
  };
}
const deps = (fetch) => ({ fetch, generateJwt: async (o) => `jwt-for-${o.requestMethod}-${o.requestPath}` });

test("creates a sandbox Apple Pay order for the signed-in saver", async () => {
  const handler = await fresh();
  const calls = [];
  const r = await handler(post(goodBody()), { ip: "1.2.3.4" }, deps(coinbase({ calls })));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.paymentLink, "https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1");
  assert.equal(j.orderId, "ord_123456");
  assert.equal(j.sandbox, true);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  // first the sign-in check, then the order
  assert.equal(calls[0].url, "https://api.cdp.coinbase.com/platform/v2/end-users/auth/validate-token");
  assert.equal(calls[0].init.headers.Authorization, "Bearer jwt-for-POST-/platform/v2/end-users/auth/validate-token");
  assert.equal(JSON.parse(calls[0].init.body).accessToken, TOKEN);
  const sent = JSON.parse(calls[1].init.body);
  assert.equal(calls[1].url, "https://api.cdp.coinbase.com/platform/v2/onramp/orders");
  assert.equal(calls[1].init.headers.Authorization, "Bearer jwt-for-POST-/platform/v2/onramp/orders");
  assert.equal(sent.partnerUserRef, "sandbox-user-123");
  assert.equal(sent.email, "saver@example.com", "the email comes from the sign-in");
  assert.equal(sent.destinationAddress, ME);
  assert.equal(sent.paymentMethod, "GUEST_CHECKOUT_APPLE_PAY");
  assert.equal(sent.purchaseCurrency, "USDC");
  assert.equal(sent.destinationNetwork, "base");
  assert.equal(sent.domain, "plutos-financial.github.io");
  assert.equal(sent.clientIp, "1.2.3.4");
});

test("needs a Plutos sign-in", async () => {
  const handler = await fresh();
  const calls = [];
  const none = await handler(post(goodBody(), { token: "" }), { ip: "7.0.0.1" }, deps(coinbase({ calls })));
  assert.equal(none.status, 401);
  assert.equal(calls.length, 0, "no Coinbase calls without a sign-in");
  const junk = await handler(post(goodBody(), { token: "not a token!" }), { ip: "7.0.0.2" }, deps(coinbase({ calls })));
  assert.equal(junk.status, 401);
  const expired = await handler(post(goodBody(), { token: "abc.def.ghi" }), { ip: "7.0.0.3" }, deps(coinbase({ calls })));
  assert.equal(expired.status, 401);
  assert.match((await expired.json()).error, /sign/i);
  assert.ok(!calls.some((c) => c.url.endsWith("/onramp/orders")), "never reaches the order step");
});

test("only pays into the saver's own account", async () => {
  const handler = await fresh();
  const calls = [];
  const r = await handler(post({ ...goodBody(), address: SOMEONE_ELSE }), { ip: "7.1.0.1" }, deps(coinbase({ calls })));
  assert.equal(r.status, 403);
  assert.ok(!calls.some((c) => c.url.endsWith("/onramp/orders")));
  const own = await handler(post({ ...goodBody(), address: OWNER_KEY.toUpperCase().replace("0X", "0x") }), { ip: "7.1.0.2" }, deps(coinbase()));
  assert.equal(own.status, 200, "the key that owns the smart account counts too");
});

test("rejects bad input", async () => {
  const handler = await fresh();
  for (const patch of [{ address: "0x123" }, { amount: "0" }, { amount: "4.99" }, { amount: "501" }, { amount: "abc" }, { amount: "1e3" }, { phone: "5551234567" }, { phone: "+10551234567" }, { agreedAt: "2020-01-01T00:00:00Z" }]) {
    const r = await handler(post({ ...goodBody(), ...patch }), { ip: `5.5.5.${Math.random()}` }, deps(coinbase()));
    assert.equal(r.status, 400, JSON.stringify(patch));
  }
  const notJson = await handler(post("[1,2]"), { ip: "5.5.6.1" }, deps(coinbase()));
  assert.equal(notJson.status, 400);
  const huge = await handler(post({ ...goodBody(), pad: "x".repeat(5000) }), { ip: "5.5.6.2" }, deps(coinbase()));
  assert.equal(huge.status, 413);
});

test("refuses sites that aren't on the list", async () => {
  const handler = await fresh();
  const r = await handler(post(goodBody(), { origin: "https://evil.example" }), { ip: "1.1.1.1" }, deps(coinbase()));
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("answers the browser's preflight, allowing the sign-in header", async () => {
  const handler = await fresh();
  const r = await handler(new Request("https://x/api/onramp-order", { method: "OPTIONS", headers: { origin: ORIGIN } }), {}, deps(coinbase()));
  assert.equal(r.status, 204);
  assert.match(r.headers.get("access-control-allow-methods"), /POST/);
  assert.match(r.headers.get("access-control-allow-headers"), /Authorization/);
});

test("rate limits after 10 tries a minute", async () => {
  const handler = await fresh();
  let last;
  for (let i = 0; i < 11; i++) last = await handler(post(goodBody()), { ip: "9.9.9.9" }, deps(coinbase()));
  assert.equal(last.status, 429);
});

test("at most 5 payments per saver every 10 minutes", async () => {
  const handler = await fresh();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await handler(post(goodBody()), { ip: `8.8.8.${i}` }, deps(coinbase()))).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);
});

test("never frames anything but Coinbase's payment page", async () => {
  const handler = await fresh();
  const evil = () => Response.json({ order: { orderId: "ord_1" }, paymentLink: { url: "https://evil.example/pay" } }, { status: 201 });
  const r = await handler(post(goodBody()), { ip: "2.2.3.3" }, deps(coinbase({ order: evil })));
  assert.equal(r.status, 502);
});

test("a Coinbase failure never leaks the secret", async () => {
  const handler = await fresh();
  const bad = () => Response.json({ errorType: "internal", errorMessage: "invalid jwt for key test-key-id" }, { status: 500 });
  const r = await handler(post(goodBody()), { ip: "2.2.2.2" }, deps(coinbase({ order: bad })));
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.ok(!text.includes("super-secret-value") && !text.includes("test-key-id") && !/jwt/i.test(text), text);
});

test("passes on Coinbase's plain reasons, like limits", async () => {
  const handler = await fresh();
  const limit = () => Response.json({ errorType: "guest_transaction_limit", errorMessage: "Weekly limit reached" }, { status: 400 });
  const r = await handler(post(goodBody()), { ip: "3.3.3.3" }, deps(coinbase({ order: limit })));
  assert.equal((await r.json()).error, "Coinbase said: Weekly limit reached");
});

test("order status, only for the saver it belongs to", async () => {
  const handler = await fresh();
  const r = await handler(get("ord_123456"), { ip: "4.4.4.4" }, deps(coinbase()));
  assert.deepEqual(await r.json(), { status: "COMPLETED", sandbox: true });
  const bad = await handler(get("../../x"), { ip: "4.4.4.5" }, deps(coinbase()));
  assert.equal(bad.status, 400);
  const anon = await handler(get("ord_123456", ""), { ip: "4.4.4.6" }, deps(coinbase()));
  assert.equal(anon.status, 401);
  const theirs = () => Response.json({ order: { status: "ONRAMP_ORDER_STATUS_COMPLETED", destinationAddress: SOMEONE_ELSE } });
  const other = await handler(get("ord_123456"), { ip: "4.4.4.7" }, deps(coinbase({ status: theirs })));
  assert.equal(other.status, 404);
});

test("says clearly when the API key is missing", async () => {
  const handler = await fresh();
  const saved = process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_API_KEY_SECRET;
  const r = await handler(post(goodBody()), { ip: "6.6.6.6" }, deps(coinbase()));
  process.env.CDP_API_KEY_SECRET = saved;
  assert.equal(r.status, 503);
});

test("a Coinbase outage during the sign-in check is a clear retry, not a pass", async () => {
  const handler = await fresh();
  const calls = [];
  const down = () => Response.json({ errorType: "service_unavailable" }, { status: 503 });
  const r = await handler(post(goodBody()), { ip: "6.6.7.7" }, deps(coinbase({ calls, validate: down })));
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, "service_unavailable");
  assert.ok(!calls.some((c) => c.url.endsWith("/onramp/orders")));
});
