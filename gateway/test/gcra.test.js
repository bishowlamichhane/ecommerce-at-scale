import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../ratelimit/limiter.js";
import { compileLimit } from "../ratelimit/policies.js";
import { testRedis, uid } from "./helpers.js";

// The GCRA script, with a fixed clock so every number is exact.

describe("GCRA limiter", () => {
  let redis;
  let limiter;
  before(async () => {
    redis = await testRedis();
    limiter = createRateLimiter({ redis, algorithm: "gcra" });
  });
  after(() => redis.disconnect());

  // 3 at once, then one every 10 s (6 a minute)
  const limit = compileLimit("test", { by: "user", burst: 3, perPeriod: 6, period: 60 });
  const T0 = 1_000_000_000_000;
  const check = (id, now, limits = [limit]) => limiter.check(limits.map((l) => ({ limit: l, id })), { now });

  async function useBurst(id) {
    for (let i = 0; i < 3; i++) assert.equal((await check(id, T0)).allowed, true);
  }

  it("allows `burst` requests at once, then refuses with an exact retry time", async () => {
    const id = uid("burst");
    for (const left of [2, 1, 0]) {
      const decision = await check(id, T0);
      assert.equal(decision.allowed, true);
      assert.equal(decision.results[0].remaining, left);
    }
    const refused = await check(id, T0);
    assert.equal(refused.allowed, false);
    assert.equal(refused.results[0].remaining, 0);
    assert.equal(refused.results[0].retryAfterMs, 10_000);
    assert.equal(refused.results[0].resetAfterMs, 30_000);
  });

  it("lets the next request through after one interval, not a millisecond earlier", async () => {
    const id = uid("interval");
    await useBurst(id);
    const early = await check(id, T0 + 9_999);
    assert.equal(early.allowed, false);
    assert.equal(early.results[0].retryAfterMs, 1);
    assert.equal((await check(id, T0 + 10_000)).allowed, true);
    assert.equal((await check(id, T0 + 10_000)).allowed, false);
  });

  it("doesn't charge for refused requests", async () => {
    const id = uid("free-refusals");
    await useBurst(id);
    for (let t = 0; t < 10_000; t += 100) assert.equal((await check(id, T0 + t)).allowed, false);
    // Hammering didn't push the next slot back: it opens exactly on time, once.
    assert.equal((await check(id, T0 + 10_000)).allowed, true);
    assert.equal((await check(id, T0 + 10_000)).allowed, false);
  });

  it("gives the whole burst back after burst × interval of quiet", async () => {
    const id = uid("refill");
    await useBurst(id);
    const later = T0 + 30_000;
    for (const left of [2, 1, 0]) assert.equal((await check(id, later)).results[0].remaining, left);
    assert.equal((await check(id, later)).allowed, false);
  });

  it("never banks more than the burst, however long a client stays quiet", async () => {
    const id = uid("no-banking");
    await check(id, T0);
    const muchLater = T0 + 24 * 3_600_000;
    const allowed = [];
    for (let i = 0; i < 5; i++) allowed.push((await check(id, muchLater)).allowed);
    assert.deepEqual(allowed, [true, true, true, false, false]);
  });

  it("checks every limit together and charges none of them when one refuses", async () => {
    const id = uid("all-or-nothing");
    const oneOnly = compileLimit("test", { by: "ip", burst: 1, perPeriod: 1, period: 60 });

    const first = await check(id, T0, [limit, oneOnly]);
    assert.equal(first.allowed, true);

    const second = await check(id, T0, [limit, oneOnly]);
    assert.equal(second.allowed, false);
    assert.equal(second.results[0].remaining, 2, "the user limit wasn't charged");
    assert.equal(second.results[0].retryAfterMs, 0, "the user limit alone would allow it");
    assert.equal(second.results[1].retryAfterMs, 60_000);

    // The user's own limit still has 2 of 3 left: the refusal cost nothing.
    assert.equal((await check(id, T0)).results[0].remaining, 1);
  });

  it("keeps clients apart", async () => {
    const a = uid("a");
    const b = uid("b");
    await useBurst(a);
    assert.equal((await check(a, T0)).allowed, false);
    assert.equal((await check(b, T0)).allowed, true);
  });

  it("lets a key expire as soon as its bucket is full again", async () => {
    const id = uid("ttl");
    await check(id, T0);
    const ttl = await redis.pttl(`rl:gcra:test-user:${id}`);
    assert.ok(ttl > 9_000 && ttl <= 10_000, `expected about 10 s, got ${ttl} ms`);
  });

  it("is atomic: 50 requests at the same moment get exactly `burst` through", async () => {
    const id = uid("race");
    // No fixed clock here: the real Redis clock, and 50 calls in flight at once.
    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => limiter.check([{ limit, id }]))
    );
    assert.equal(decisions.filter((d) => d.allowed).length, 3);
  });
});
