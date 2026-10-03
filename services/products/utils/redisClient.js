import Redis from "ioredis";

// Two connections to the same Redis, because their two jobs fail differently:
//
//   redis       stock counters and reservations (redis checkout mode). A sale
//               can't go on without them: a command may wait up to 1 s, then
//               fails and the request gets an error.
//   cacheRedis  the catalog cache, which only speeds things up. It gives up
//               after 100 ms, and the request reads Postgres instead.
//
// Neither queues commands while disconnected, nor retries them. ioredis's
// defaults did both, which made requests hang for as long as Redis was down.
// Both keep reconnecting in the background.
//
// REDIS_DB lets the tests work in a database of their own.
function connect(name, options) {
  const client = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT || 6379),
    db: Number(process.env.REDIS_DB || 0),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
    ...options,
  });

  // Reconnect attempts repeat the same error, so only log when it changes.
  let lastError = "";
  client.on("ready", () => {
    lastError = "";
    console.log(`🚀 Redis connected (products, ${name})`);
  });
  client.on("error", (error) => {
    if (error.message !== lastError) console.error(`❌ Redis error (products, ${name}): ${error.message}`);
    lastError = error.message;
  });
  return client;
}

const redis = connect("inventory", { commandTimeout: 1000 });
export const cacheRedis = connect("cache", { commandTimeout: 100, enableAutoPipelining: true });

// Resolves true once the client is connected, or false after `timeoutMs`.
// Startup doesn't need Redis: the cache falls back to Postgres until it's back.
export const waitForRedis = (client, timeoutMs = 3000) =>
  new Promise((resolve) => {
    if (client.status === "ready") return resolve(true);
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      resolve(false);
    }, timeoutMs);
    client.once("ready", onReady);
  });

export default redis;
