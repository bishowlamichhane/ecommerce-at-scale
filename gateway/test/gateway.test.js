import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createApp } from "../app.js";
import { createRateLimiter } from "../ratelimit/limiter.js";
import { POLICIES, compilePolicies } from "../ratelimit/policies.js";
import { deadRedis, recordingLogger, silentLogger, testRedis } from "./helpers.js";

// The real gateway (CORS, identity, rate limiter, proxies) in front of a fake
// upstream that records what reaches it.

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

describe("gateway with rate limiting", () => {
  let redis;
  let upstream;
  let received;
  const servers = [];
  const clients = [];

  before(async () => {
    redis = await testRedis();
    received = [];
    const fake = express();
    fake.use((req, res) => {
      received.push(`${req.method} ${req.url}`);
      res.json({ upstream: true });
    });
    upstream = await listen(fake);
    servers.push(upstream);
  });

  after(() => {
    for (const server of servers) server.close();
    for (const client of [redis, ...clients]) client.disconnect();
  });

  // Each test starts from clean limits and an empty upstream log.
  beforeEach(async () => {
    await redis.flushdb();
    received.length = 0;
  });

  async function gateway({ algorithm = "gcra", failMode = "open", trustProxy = false, client = redis, logger = silentLogger } = {}) {
    const target = urlOf(upstream);
    const app = createApp({
      services: { products: target, cart: target, orders: target, search: target },
      trustProxy,
      limiter: createRateLimiter({ redis: client, algorithm }),
      policies: compilePolicies(POLICIES),
      failMode,
      logger,
    });
    const server = await listen(app);
    servers.push(server);
    return urlOf(server);
  }

  const buy = (base, headers = {}, path = "/orders/buy-now") =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });

  it("passes allowed requests through, with RateLimit headers", async () => {
    const base = await gateway();
    const res = await fetch(`${base}/products/get-products?limit=20`, { headers: { "X-User-Id": "alice" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { upstream: true });
    assert.deepEqual(received, ["GET /get-products?limit=20"]);
    assert.equal(res.headers.get("ratelimit-policy"), '"default-ip";q=100;w=5');
    assert.match(res.headers.get("ratelimit"), /^"default-ip";r=99;t=1$/);
  });

  it("checkout: 3 tries at once per shopper, then 429 with Retry-After", async () => {
    const base = await gateway();
    for (let i = 0; i < 3; i++) assert.equal((await buy(base, { "X-User-Id": "alice" })).status, 200);

    const res = await buy(base, { "X-User-Id": "alice" });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "10");
    assert.deepEqual(await res.json(), { message: "Too many requests. Try again in 10 s.", success: false, retryAfter: 10 });
    assert.match(res.headers.get("ratelimit"), /"checkout-user";r=0;t=30, "checkout-ip";r=7;t=\d+/);
    assert.equal(received.length, 3, "the refused request never reached the orders service");

    // Another shopper isn't affected.
    assert.equal((await buy(base, { "X-User-Id": "bob" })).status, 200);
  });

  it("counts every spelling of a checkout path against the same limit", async () => {
    const base = await gateway();
    const who = { "X-User-Id": "carol" };
    assert.equal((await buy(base, who, "/orders/buy-now")).status, 200);
    assert.equal((await buy(base, who, "/ORDERS/BUY-NOW/")).status, 200);
    assert.equal((await buy(base, who, "/orders/place-order")).status, 200);
    assert.equal((await buy(base, who, "/Orders/Buy-Now")).status, 429);
  });

  it("limits reads under /orders only as browsing", async () => {
    const base = await gateway();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/orders/check-order-status-by-id/1`, { headers: { "X-User-Id": "dave" } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("ratelimit-policy"), /^"default-ip"/);
    }
  });

  it("never limits CORS preflight requests, even for a shopper who is out of tries", async () => {
    const base = await gateway();
    for (let i = 0; i < 4; i++) await buy(base, { "X-User-Id": "erin" });
    const preflight = await fetch(`${base}/orders/buy-now`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-user-id",
        "X-User-Id": "erin",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("ratelimit"), null);
  });

  it("lets the browser read the limit headers on a 429", async () => {
    const base = await gateway();
    const origin = { Origin: "http://localhost:5173", "X-User-Id": "frank" };
    for (let i = 0; i < 3; i++) await buy(base, origin);
    const res = await buy(base, origin);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const exposed = res.headers.get("access-control-expose-headers");
    for (const header of ["Retry-After", "RateLimit", "RateLimit-Policy"]) assert.ok(exposed.includes(header), `${header} is exposed`);
  });

  it("limits a request without X-User-Id by IP only, never through a shared guest bucket", async () => {
    const base = await gateway();
    const res = await buy(base);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("ratelimit-policy"), '"checkout-ip";q=10;w=10');
  });

  it("refuses malformed shopper ids before anything else sees them", async () => {
    const base = await gateway();
    const duplicate = new Headers({ "Content-Type": "application/json" });
    duplicate.append("X-User-Id", "alice");
    duplicate.append("X-User-Id", "mallory");
    const attempts = [
      buy(base, { "X-User-Id": "has space" }),
      buy(base, { "X-User-Id": "x".repeat(65) }),
      buy(base, { "X-User-Id": "" }),
      fetch(`${base}/orders/buy-now`, { method: "POST", headers: duplicate, body: "{}" }),
    ];
    for (const res of await Promise.all(attempts)) {
      assert.equal(res.status, 400);
      assert.equal((await res.json()).success, false);
    }
    assert.equal(received.length, 0);
  });

  it("ignores X-Forwarded-For from untrusted clients, so faking IPs gains nothing", async () => {
    const base = await gateway({ trustProxy: false });
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await buy(base, { "X-Forwarded-For": `198.51.100.${i}` })).status);
    // All 11 count as the same IP: 10 allowed at once, then refused.
    assert.deepEqual(statuses, [...Array(10).fill(200), 429]);
  });

  it("uses X-Forwarded-For when the proxy in front is trusted", async () => {
    const base = await gateway({ trustProxy: "loopback" });
    for (let i = 0; i < 11; i++) assert.equal((await buy(base, { "X-Forwarded-For": `198.51.100.${i}` })).status, 200);
  });

  it("keeps the services' internal endpoints closed", async () => {
    const base = await gateway();
    const attempts = [
      buy(base, { "X-User-Id": "gina" }, "/products/inventory/reserve"),
      fetch(`${base}/products/inventory/stale?olderThanMs=0`),
      fetch(`${base}/orders/admin/queues`),
      fetch(`${base}/ORDERS/ADMIN/queues/api/queues`),
    ];
    for (const res of await Promise.all(attempts)) assert.equal(res.status, 404);
    assert.equal(received.length, 0);
  });

  it("does nothing when switched off", async () => {
    const base = await gateway({ algorithm: "off" });
    for (let i = 0; i < 5; i++) {
      const res = await buy(base, { "X-User-Id": "henry" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("ratelimit"), null);
    }
  });

  it("describes fixed windows as quota per window", async () => {
    const base = await gateway({ algorithm: "fixed-window" });
    const res = await fetch(`${base}/`);
    assert.equal(res.headers.get("ratelimit-policy"), '"default-ip";q=1200;w=60');
  });

  it("fails open, fast and with one warning, when Redis is down", async () => {
    const down = deadRedis();
    clients.push(down);
    const logger = recordingLogger();
    const base = await gateway({ client: down, logger });

    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 5 }, () => buy(base, { "X-User-Id": "ivan" })));
    const elapsed = performance.now() - started;

    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.equal(results[0].headers.get("ratelimit"), null);
    assert.ok(elapsed < 500, `answered in ${Math.round(elapsed)} ms`);
    assert.equal(logger.warnings.length, 1, "one warning, not one per request");
    assert.match(logger.warnings[0], /failing open/);
  });

  it("fails closed with 503 when configured to", async () => {
    const down = deadRedis();
    clients.push(down);
    const base = await gateway({ client: down, failMode: "closed" });
    const res = await buy(base, { "X-User-Id": "judy" });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "1");
    assert.equal(received.length, 0);
  });
});
