import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../ratelimit/limiter.js";
import { compileLimit } from "../ratelimit/policies.js";
import { testRedis, uid } from "./helpers.js";

// The fixed-window baseline, and the flaw that makes GCRA worth it.

describe("fixed-window limiter (baseline)", () => {
  let redis;
  before(async () => {
    redis = await testRedis();
  });
  after(() => redis.disconnect());

  // 5 requests per 10-second window; as GCRA: 5 at once, then one every 2 s.
  const limit = compileLimit("edge", { by: "user", burst: 5, perPeriod: 5, period: 10 });
  const WINDOW_START = 1_000_000_000_000; // divisible by 10 000: a window edge

  it("allows `limit` requests per window and starts over in the next", async () => {
    const limiter = createRateLimiter({ redis, algorithm: "fixed-window" });
    const id = uid("window");
    const check = (now) => limiter.check([{ limit, id }], { now });

    for (const left of [4, 3, 2, 1, 0]) assert.equal((await check(WINDOW_START + 1_000)).results[0].remaining, left);
    const refused = await check(WINDOW_START + 1_000);
    assert.equal(refused.allowed, false);
    assert.equal(refused.results[0].retryAfterMs, 9_000, "until the window ends");

    assert.equal((await check(WINDOW_START + 10_000)).allowed, true);
  });

  it("lets twice the limit through across a window edge, where GCRA holds the line", async (t) => {
    const justBefore = WINDOW_START + 10_000 - 10; // 10 ms before a window ends
    const justAfter = WINDOW_START + 10_000 + 5;   //  5 ms after the next one starts

    async function admitted(algorithm) {
      const limiter = createRateLimiter({ redis, algorithm });
      const id = uid(algorithm);
      let count = 0;
      for (const now of [justBefore, justAfter]) {
        for (let i = 0; i < 10; i++) {
          if ((await limiter.check([{ limit, id }], { now })).allowed) count += 1;
        }
      }
      return count;
    }

    const fixed = await admitted("fixed-window");
    const gcra = await admitted("gcra");
    t.diagnostic(`limit 5 per 10 s, 20 requests within 15 ms of a window edge: fixed window allowed ${fixed}, GCRA allowed ${gcra}`);
    assert.equal(fixed, 10);
    assert.equal(gcra, 5);
  });
});
