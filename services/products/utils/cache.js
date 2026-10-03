import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// A read-through cache in Redis for data that lives in Postgres
// (cache-aside), with three classic problems handled:
//
//  1. Invalidation without scanning. Every entry is stored with the cache
//     version it was read under, and a read only accepts an entry whose
//     version is current. Invalidating is one INCR of the version: O(1),
//     however much is cached. Old entries simply stop matching.
//  2. Stale sets. A slow read that started before an invalidation stores its
//     old data under the old version, so no later read ever accepts it. (If
//     it overwrites a newer entry, that costs one extra miss, never a wrong
//     answer.)
//  3. Stampedes. When an entry is missing, one request reads the database and
//     the others wait for its result: inside a process through a shared
//     promise, and across processes through a short Redis lock (the idea
//     behind the "leases" in Facebook's memcache paper, NSDI 2013). Waiting is
//     bounded: a waiter that doesn't see the value in time reads the database
//     itself.
//
// Redis is optional: if it's down or slow, reads go straight to the database
// (fail open). Two failures need more than that:
//  - A frozen Redis (nothing answers, so every command waits out its timeout).
//    After a failed read, Redis is skipped for `retryAfterMs`, so a freeze
//    costs one timeout per interval instead of one per request.
//  - An invalidation that can't reach Redis. Entries cached before the change
//    stay "current", since the version didn't move. This process serves
//    nothing cached until an invalidation started after that failure gets
//    through; reads retry it, one at a time. (Another process could still
//    serve such an entry until then, for at most its TTL.)
//
// Modes, to measure what each protection buys:
//   off        never cache
//   plain      cache-aside with versioning, but no stampede protection
//   protected  all of the above (the default)
//
// Every read also reports what happened, in the vocabulary of the
// Cache-Status header (RFC 9211); see cacheStatusHeader().

export const CACHE_MODES = ["off", "plain", "protected"];

const unlockScript = readFileSync(new URL("../lua/unlock.lua", import.meta.url), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCache({
  redis,
  name,
  mode = "protected",
  lockTtlMs = 3000, // longest a crashed lock holder can make others wait to take over
  waitMs = 1000, // longest a request waits for another request's database read
  pollMs = 25,
  retryAfterMs = 1000, // after Redis fails, how long reads go straight to the database
  logger = console,
}) {
  if (!CACHE_MODES.includes(mode)) throw new Error(`cache mode must be one of: ${CACHE_MODES.join(", ")}`);
  if (!redis.unlockCacheLock) redis.defineCommand("unlockCacheLock", { lua: unlockScript, numberOfKeys: 1 });

  const versionKey = `${name}:version`;
  const entryKey = (key) => `${name}:${key}`;
  const lockKey = (key, version) => `${name}:lock:${key}:${version}`;
  const flights = new Map(); // reads of the database in progress, by key and version
  const warn = throttledWarning(logger, 10_000);
  let redisRetryAt = 0; // until then, Redis is skipped
  let attempts = 0; // invalidations started, numbered in order
  let owed = 0; // the latest invalidation that didn't reach Redis (0: none)
  let retrying = null;

  // One round trip: the current version and the stored entry. A corrupt entry
  // counts as missing and gets overwritten.
  async function lookup(key) {
    const [version, raw] = await redis.mget(versionKey, entryKey(key));
    let entry = null;
    if (raw !== null) {
      try {
        entry = JSON.parse(raw);
      } catch {
        entry = null;
      }
    }
    return { version: Number(version ?? 0), entry };
  }

  const isCurrent = (entry, version) => entry !== null && entry.v === version;

  // Reads the database and stores the result under `version`. A failed store
  // doesn't fail the request: the value is still good to return.
  async function loadAndStore(key, version, load, ttlSeconds) {
    const value = await load();
    let stored = false;
    try {
      const entry = { v: version, exp: Date.now() + ttlSeconds * 1000, data: value };
      await redis.set(entryKey(key), JSON.stringify(entry), "EX", ttlSeconds);
      stored = true;
    } catch (error) {
      warn(`Cache store failed (${error.message})`);
    }
    return { value, status: { fwd: "uri-miss", stored } };
  }

  // protected mode, across processes: whoever takes the lock for this key and
  // version reads the database; everyone else polls for what it stores.
  async function refill(key, version, load, ttlSeconds) {
    const lock = lockKey(key, version);
    const token = randomUUID();
    let locked;
    try {
      locked = (await redis.set(lock, token, "PX", lockTtlMs, "NX")) === "OK";
    } catch {
      return loadAndStore(key, version, load, ttlSeconds);
    }

    if (locked) {
      try {
        return await loadAndStore(key, version, load, ttlSeconds);
      } finally {
        redis.unlockCacheLock(lock, token).catch(() => {});
      }
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let found;
      try {
        found = await lookup(key);
      } catch {
        break;
      }
      if (isCurrent(found.entry, version)) {
        return { value: found.entry.data, status: { fwd: "uri-miss", collapsed: true } };
      }
      // Invalidated while we waited: the value we're waiting for is already
      // outdated. Read the database under the new version instead.
      if (found.version !== version) {
        version = found.version;
        break;
      }
    }
    // The lock holder is slow, or died: read the database ourselves.
    return loadAndStore(key, version, load, ttlSeconds);
  }

  // Returns { value, status }. `load` reads the database; it's only called
  // when the cache can't answer.
  async function read(key, load, { ttlSeconds }) {
    if (mode === "off") return { value: await load(), status: { fwd: "bypass", detail: "off" } };
    if (Date.now() < redisRetryAt || (owed && !(await settleInvalidation())))
      return { value: await load(), status: { fwd: "bypass", detail: "redis-unavailable" } };

    let found;
    try {
      found = await lookup(key);
    } catch (error) {
      redisRetryAt = Date.now() + retryAfterMs;
      warn(`Cache unavailable (${error.message}), reading the database`);
      return { value: await load(), status: { fwd: "bypass", detail: "redis-unavailable" } };
    }
    if (isCurrent(found.entry, found.version)) {
      const ttl = Math.max(0, Math.round((found.entry.exp - Date.now()) / 1000));
      return { value: found.entry.data, status: { hit: true, ttl } };
    }

    if (mode === "plain") return loadAndStore(key, found.version, load, ttlSeconds);

    // protected, inside this process: requests that miss the same key and
    // version at the same time share one read of the database.
    const flightKey = `${key}@${found.version}`;
    const inFlight = flights.get(flightKey);
    if (inFlight) {
      const { value } = await inFlight;
      return { value, status: { fwd: "uri-miss", collapsed: true } };
    }
    const flight = refill(key, found.version, load, ttlSeconds).finally(() => flights.delete(flightKey));
    flights.set(flightKey, flight);
    return flight;
  }

  // After a write to the database: every cached entry becomes outdated at
  // once. Never throws: a failure is remembered and retried (see the top).
  async function invalidate() {
    const attempt = ++attempts;
    try {
      await redis.incr(versionKey);
      // This INCR covers the failed one only if it started after it: one that
      // started earlier may have run before that change was written.
      if (attempt > owed) owed = 0;
    } catch (error) {
      owed = Math.max(owed, attempt);
      redisRetryAt = Date.now() + retryAfterMs;
      warn(`Cache invalidation failed (${error.message}); serving nothing cached until it gets through`);
    }
  }

  // Retries an owed invalidation; true once none is owed. Concurrent reads
  // share one retry.
  async function settleInvalidation() {
    retrying ??= invalidate().finally(() => {
      retrying = null;
    });
    await retrying;
    return owed === 0;
  }

  return { mode, read, invalidate };
}

// The Cache-Status response header (RFC 9211) for a read's status:
//   catalog; hit; ttl=42                      served from Redis, fresh for 42 s more
//   catalog; fwd=uri-miss; stored             this request read the database and cached it
//   catalog; fwd=uri-miss; collapsed          this request waited for another request's read
//   catalog; fwd=bypass; detail=off           the cache was skipped (off, unavailable...)
export function cacheStatusHeader(name, status) {
  const parts = [name];
  if (status.hit) {
    parts.push("hit");
    if (status.ttl !== undefined) parts.push(`ttl=${status.ttl}`);
  } else {
    parts.push(`fwd=${status.fwd}`);
    if (status.stored) parts.push("stored");
    if (status.collapsed) parts.push("collapsed");
    if (status.detail) parts.push(`detail=${status.detail}`);
  }
  return parts.join("; ");
}

// Logs the first warning at once, then at most one line per interval saying
// how many were skipped, so an outage doesn't flood the logs.
function throttledWarning(logger, intervalMs) {
  let last = 0;
  let skipped = 0;
  return (message) => {
    const now = Date.now();
    if (now - last < intervalMs) {
      skipped += 1;
      return;
    }
    logger.warn(skipped > 0 ? `${message} (+${skipped} more since the last warning)` : message);
    last = now;
    skipped = 0;
  };
}
