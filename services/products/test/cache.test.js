import "./env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import Redis from "ioredis";
import redis, { cacheRedis, waitForRedis } from "../utils/redisClient.js";
import { cacheStatusHeader, createCache } from "../utils/cache.js";
import { uid } from "./helpers.js";

// The cache against a real Redis (test database 14). The "database" is a
// loader function that counts its calls, so every test can say exactly how
// many reads reached it.

const silent = { warn() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TTL = { ttlSeconds: 60 };

const ROWS = { rows: [1, 2, 3] };

// A fake database read: returns `value` (undefined = not found), counts its
// calls, optionally slowly.
function database(value, delayMs = 0) {
  const load = async () => {
    load.calls += 1;
    if (delayMs) await sleep(delayMs);
    return value;
  };
  load.calls = 0;
  return load;
}

// A fresh cache name per test keeps versions and keys apart.
const newCache = (options = {}) => createCache({ redis: cacheRedis, name: uid("test"), logger: silent, ...options });

before(async () => {
  assert.ok(await waitForRedis(cacheRedis), "Redis isn't reachable: docker compose up -d redis");
});

after(() => {
  redis.disconnect();
  cacheRedis.disconnect();
});

describe("cache: basics", () => {
  it("reads the database once, then serves hits with their remaining TTL", async () => {
    const cache = newCache();
    const load = database(ROWS);
    const first = await cache.read("page", load, TTL);
    assert.deepEqual(first.status, { fwd: "uri-miss", stored: true });
    const second = await cache.read("page", load, TTL);
    assert.equal(second.status.hit, true);
    assert.ok(second.status.ttl > 55 && second.status.ttl <= 60, `ttl ${second.status.ttl}`);
    assert.deepEqual(second.value, first.value);
    assert.equal(load.calls, 1);
  });

  it("makes every entry outdated with one INCR", async () => {
    const cache = newCache();
    const load = database(ROWS);
    await cache.read("a", load, TTL);
    await cache.read("b", load, TTL);
    await cache.invalidate();
    assert.equal((await cache.read("a", load, TTL)).status.fwd, "uri-miss");
    assert.equal((await cache.read("b", load, TTL)).status.fwd, "uri-miss");
    assert.equal(load.calls, 4);
  });

  it("remembers 'not found' too, so missing ids can't hammer the database", async () => {
    const cache = newCache();
    const load = database(undefined);
    assert.equal((await cache.read("item:999", load, TTL)).value, undefined);
    const again = await cache.read("item:999", load, TTL);
    assert.equal(again.status.hit, true);
    assert.equal(again.value, undefined);
    assert.equal(load.calls, 1);
  });

  it("treats a corrupt entry as missing and replaces it", async () => {
    const name = uid("test");
    const cache = createCache({ redis: cacheRedis, name, logger: silent });
    await cacheRedis.set(`${name}:page`, "not json");
    const load = database(ROWS);
    assert.equal((await cache.read("page", load, TTL)).status.stored, true);
    assert.equal((await cache.read("page", load, TTL)).status.hit, true);
    assert.equal(load.calls, 1);
  });

  it("lets Redis expire entries, so outdated versions don't pile up", async () => {
    const name = uid("test");
    const cache = createCache({ redis: cacheRedis, name, logger: silent });
    await cache.read("page", database(ROWS), { ttlSeconds: 30 });
    const pttl = await cacheRedis.pttl(`${name}:page`);
    assert.ok(pttl > 29_000 && pttl <= 30_000, `pttl ${pttl}`);
  });

  it("never caches in off mode", async () => {
    const cache = newCache({ mode: "off" });
    const load = database(ROWS);
    const result = await cache.read("page", load, TTL);
    await cache.read("page", load, TTL);
    assert.deepEqual(result.status, { fwd: "bypass", detail: "off" });
    assert.equal(load.calls, 2);
  });
});

describe("cache: stale sets", () => {
  for (const mode of ["plain", "protected"]) {
    it(`${mode}: a slow read that overlaps a change can't plant old data`, async () => {
      const cache = newCache({ mode });
      let row = "old";
      // Reads the row first, then is slow to return it, like a busy database.
      const load = async () => {
        const snapshot = row;
        await sleep(60);
        return snapshot;
      };

      const slowRead = cache.read("item:1", load, TTL);
      await sleep(10);
      row = "new";
      await cache.invalidate(); // the writer's invalidation lands mid-read
      assert.equal((await slowRead).value, "old", "the slow read itself returns what it read");

      // ...but what it stored belongs to the old version, so nobody gets it again.
      const next = await cache.read("item:1", load, TTL);
      assert.equal(next.value, "new");
    });
  }
});

describe("cache: stampedes", () => {
  it("plain: 50 simultaneous misses mean 50 database reads (the problem)", async () => {
    const cache = newCache({ mode: "plain" });
    const load = database(ROWS, 30);
    await Promise.all(Array.from({ length: 50 }, () => cache.read("hot", load, TTL)));
    assert.equal(load.calls, 50);
  });

  it("protected: 50 simultaneous misses share one database read", async () => {
    const cache = newCache();
    const load = database({ rows: [1] }, 30);
    const results = await Promise.all(Array.from({ length: 50 }, () => cache.read("hot", load, TTL)));
    assert.equal(load.calls, 1);
    assert.equal(results.filter((r) => r.status.stored).length, 1);
    assert.equal(results.filter((r) => r.status.collapsed).length, 49);
    for (const r of results) assert.deepEqual(r.value, { rows: [1] });
  });

  it("protected: requests in one process share a read without the Redis lock's help", async () => {
    // waitMs 0: a request that loses the Redis lock reads the database at
    // once, so only the in-process sharing can keep this to one read.
    const cache = newCache({ waitMs: 0 });
    const load = database(ROWS, 30);
    await Promise.all(Array.from({ length: 50 }, () => cache.read("hot", load, TTL)));
    assert.equal(load.calls, 1);
  });

  it("protected: two processes share one read through the Redis lock", async () => {
    const name = uid("test");
    // Two cache instances = two processes: separate in-process sharing, one Redis.
    const processA = createCache({ redis: cacheRedis, name, logger: silent });
    const processB = createCache({ redis: cacheRedis, name, logger: silent });
    const load = database({ rows: [1] }, 100);
    const reads = [
      ...Array.from({ length: 25 }, () => processA.read("hot", load, TTL)),
      ...Array.from({ length: 25 }, () => processB.read("hot", load, TTL)),
    ];
    const results = await Promise.all(reads);
    assert.equal(load.calls, 1, "one database read across both processes");
    assert.equal(results.filter((r) => r.status.collapsed).length, 49);
  });

  it("protected: a crashed lock holder costs a bounded wait, not an outage", async () => {
    const name = uid("test");
    const cache = createCache({ redis: cacheRedis, name, logger: silent, waitMs: 200, pollMs: 20 });
    // Someone took the lock for this key (version 0) and died without storing anything.
    const lock = `${name}:lock:hot:0`;
    await cacheRedis.set(lock, "crashed-holder", "PX", 5000);

    const load = database(ROWS);
    const started = Date.now();
    const result = await cache.read("hot", load, TTL);
    const waited = Date.now() - started;

    assert.ok(waited >= 200 && waited < 1000, `waited ${waited} ms`);
    assert.equal(result.status.stored, true, "it read the database itself and filled the cache");
    assert.equal(load.calls, 1);
    assert.equal(await cacheRedis.get(lock), "crashed-holder", "someone else's lock is left alone");
  });

  it("protected: a failed database read reaches every waiter, isn't cached, and frees the lock", async () => {
    const name = uid("test");
    const cache = createCache({ redis: cacheRedis, name, logger: silent });
    let calls = 0;
    const failing = async () => {
      calls += 1;
      await sleep(30);
      throw new Error("database down");
    };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => cache.read("hot", failing, TTL)));
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r.status === "rejected" && r.reason.message === "database down"));
    assert.equal(await cacheRedis.get(`${name}:lock:hot:0`), null, "the lock was released");

    const load = database(ROWS);
    assert.equal((await cache.read("hot", load, TTL)).status.stored, true, "the next read tries again");
  });

  it("only ever releases its own lock", async () => {
    newCache(); // registers the unlock script
    const lock = `${uid("test")}:lock:x:0`;
    await cacheRedis.set(lock, "theirs", "PX", 5000);
    assert.equal(await cacheRedis.unlockCacheLock(lock, "mine"), 0);
    assert.equal(await cacheRedis.get(lock), "theirs");
    assert.equal(await cacheRedis.unlockCacheLock(lock, "theirs"), 1);
    assert.equal(await cacheRedis.get(lock), null);
  });
});

// A "Redis" that accepts connections and never answers: what a frozen or
// partitioned Redis looks like to a client.
async function frozenRedis() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Redis({
    host: "127.0.0.1",
    port: server.address().port,
    enableReadyCheck: false, // the ready check would wait forever for its answer
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 100, // as the products service's cache client
    retryStrategy: () => null,
  });
  client.on("error", () => {});
  await new Promise((resolve) => client.once("ready", resolve));
  return {
    client,
    close() {
      client.disconnect();
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

// The real Redis, except that invalidations (INCR) can be made to fail.
function flakyRedis() {
  const flaky = {
    incrFails: false,
    incrCalls: 0,
    mget: (...args) => cacheRedis.mget(...args),
    set: (...args) => cacheRedis.set(...args),
    unlockCacheLock: (...args) => cacheRedis.unlockCacheLock(...args),
    incr(...args) {
      flaky.incrCalls += 1;
      return flaky.incrFails ? Promise.reject(new Error("connection lost")) : cacheRedis.incr(...args);
    },
  };
  return flaky;
}

describe("cache: Redis down", () => {
  it("reads the database at once, and invalidation doesn't throw", async () => {
    // A client pointed at a port where nothing listens.
    const dead = new Redis({
      host: "127.0.0.1",
      port: 1,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on("error", () => {});
    const cache = createCache({ redis: dead, name: uid("test"), logger: silent });
    const load = database(ROWS);

    const started = Date.now();
    const result = await cache.read("page", load, TTL);
    const took = Date.now() - started;

    assert.deepEqual(result.status, { fwd: "bypass", detail: "redis-unavailable" });
    assert.deepEqual(result.value, { rows: [1, 2, 3] });
    assert.ok(took < 200, `took ${took} ms`);
    await cache.invalidate();
    dead.disconnect();
  });

  it("a frozen Redis costs one timeout per interval, not one per request", async () => {
    const frozen = await frozenRedis();
    try {
      const cache = createCache({ redis: frozen.client, name: uid("test"), logger: silent, retryAfterMs: 300 });
      const load = database(ROWS);
      const timed = async () => {
        const started = Date.now();
        const result = await cache.read("page", load, TTL);
        assert.deepEqual(result.status, { fwd: "bypass", detail: "redis-unavailable" });
        return Date.now() - started;
      };

      const first = await timed();
      assert.ok(first >= 90, `the first read waited out the timeout: ${first} ms`);
      const second = await timed();
      assert.ok(second < 50, `the next read skipped Redis: ${second} ms`);
      await sleep(300);
      const later = await timed();
      assert.ok(later >= 90, `after retryAfterMs it tries Redis again: ${later} ms`);
      assert.equal(load.calls, 3);
    } finally {
      frozen.close();
    }
  });

  it("after a failed invalidation, reads skip a frozen Redis instead of retrying on every request", async () => {
    const frozen = await frozenRedis();
    try {
      const cache = createCache({ redis: frozen.client, name: uid("test"), logger: silent, retryAfterMs: 300 });
      await cache.invalidate(); // waits out the timeout, and fails
      const started = Date.now();
      const result = await cache.read("page", database(ROWS), TTL);
      const took = Date.now() - started;
      assert.deepEqual(result.status, { fwd: "bypass", detail: "redis-unavailable" });
      assert.ok(took < 50, `took ${took} ms`);
    } finally {
      frozen.close();
    }
  });

  it("a change made while Redis was unreachable is never hidden by an entry cached before it", async () => {
    const flaky = flakyRedis();
    const cache = createCache({ redis: flaky, name: uid("test"), mode: "plain", logger: silent, retryAfterMs: 0 });
    let row = "old";
    const load = async () => row;

    await cache.read("item:1", load, TTL); // "old" is cached
    row = "new";
    flaky.incrFails = true;
    await cache.invalidate(); // can't reach Redis: "old" is still there, and still current

    const meanwhile = await cache.read("item:1", load, TTL);
    assert.deepEqual(meanwhile, { value: "new", status: { fwd: "bypass", detail: "redis-unavailable" } });

    // Redis is back: the next read gets the invalidation through first.
    flaky.incrFails = false;
    const after = await cache.read("item:1", load, TTL);
    assert.deepEqual(after, { value: "new", status: { fwd: "uri-miss", stored: true } });
    assert.equal(flaky.incrCalls, 3);
  });

  it("an older invalidation that finishes late doesn't excuse a newer one that failed", async () => {
    const flaky = flakyRedis();
    const cache = createCache({ redis: flaky, name: uid("test"), mode: "plain", logger: silent, retryAfterMs: 0 });
    // The first INCR is slow and succeeds; the second fails at once.
    let finishFirst;
    flaky.incr = (...args) => {
      flaky.incrCalls += 1;
      if (flaky.incrCalls === 1) return new Promise((resolve) => (finishFirst = () => resolve(cacheRedis.incr(...args))));
      if (flaky.incrCalls === 2) return Promise.reject(new Error("connection lost"));
      return cacheRedis.incr(...args);
    };

    const first = cache.invalidate();
    await cache.invalidate(); // fails
    finishFirst();
    await first; // it started before the failed one, so it may have run before that change was written

    await cache.read("page", database(ROWS), TTL);
    assert.equal(flaky.incrCalls, 3, "the read retried the failed invalidation first");
  });

  it("reads share one retry of an owed invalidation", async () => {
    const flaky = flakyRedis();
    const cache = createCache({ redis: flaky, name: uid("test"), mode: "plain", logger: silent, retryAfterMs: 0 });
    flaky.incrFails = true;
    await cache.invalidate();
    flaky.incrFails = false;
    await Promise.all(Array.from({ length: 20 }, () => cache.read("page", database(ROWS), TTL)));
    assert.equal(flaky.incrCalls, 2, "one failed invalidation, one shared retry");
  });
});

describe("Cache-Status header (RFC 9211)", () => {
  const cases = [
    [{ hit: true, ttl: 42 }, "catalog; hit; ttl=42"],
    [{ fwd: "uri-miss", stored: true }, "catalog; fwd=uri-miss; stored"],
    [{ fwd: "uri-miss", stored: false }, "catalog; fwd=uri-miss"],
    [{ fwd: "uri-miss", collapsed: true }, "catalog; fwd=uri-miss; collapsed"],
    [{ fwd: "bypass", detail: "redis-unavailable" }, "catalog; fwd=bypass; detail=redis-unavailable"],
  ];
  for (const [status, header] of cases) {
    it(header, () => assert.equal(cacheStatusHeader("catalog", status), header));
  }
});
