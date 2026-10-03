import Redis from "ioredis";

// The rate limiter sits in front of every request, so a slow or missing
// Redis has to cost milliseconds, not seconds. ioredis's defaults queue
// commands while disconnected and retry them, which would make every request
// wait for Redis to come back.
export function createRedisClient({ host, port, db = 0 }, logger = console) {
  const redis = new Redis({
    host,
    port,
    db,
    enableOfflineQueue: false, // while disconnected, fail commands at once instead of queueing them
    maxRetriesPerRequest: 0,   // never retry a command: the limiter decides what a failure means
    commandTimeout: 100,       // milliseconds
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000), // keep reconnecting in the background
    // Under load many requests check their limits in the same tick; send those
    // commands to Redis in one write instead of one write each.
    enableAutoPipelining: true,
  });

  // Reconnect attempts repeat the same error, so only log when it changes.
  let lastError = "";
  redis.on("ready", () => {
    lastError = "";
    logger.log(`🚀 Redis connected (gateway rate limiter) ${host}:${port}`);
  });
  redis.on("error", (error) => {
    if (error.message !== lastError) logger.warn(`Redis error (gateway): ${error.message}`);
    lastError = error.message;
  });

  return redis;
}
