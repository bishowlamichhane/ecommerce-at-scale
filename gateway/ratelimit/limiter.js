import { readFileSync } from "node:fs";

// Runs one of the Lua scripts in Redis: one round trip, atomic, every limit
// of a request checked together.
//
// Each algorithm stores a different kind of value, so each gets its own key
// prefix. Switching algorithms then can't trip over the other's keys (Redis
// would answer WRONGTYPE, and the limiter would fail open).
const SCRIPTS = {
  gcra: {
    command: "rateLimitGcra",
    file: "gcra.lua",
    keyPrefix: "rl:gcra",
    args: (limit) => [limit.intervalMs, limit.burst],
  },
  "fixed-window": {
    command: "rateLimitFixedWindow",
    file: "fixedWindow.lua",
    keyPrefix: "rl:fw",
    args: (limit) => [limit.windowMs, limit.perPeriod],
  },
};

export const ALGORITHMS = ["gcra", "fixed-window", "off"];

export function createRateLimiter({ redis, algorithm }) {
  if (!ALGORITHMS.includes(algorithm))
    throw new Error(`rate limit algorithm must be one of ${ALGORITHMS.join(", ")}, got "${algorithm}"`);
  if (algorithm === "off") return { algorithm, check: async () => ({ allowed: true, results: [] }) };

  const script = SCRIPTS[algorithm];
  // ioredis sends the script by its hash (EVALSHA) and falls back to the full
  // text when Redis doesn't know it yet, e.g. right after a Redis restart.
  if (!redis[script.command]) {
    const lua = readFileSync(new URL(script.file, import.meta.url), "utf8");
    redis.defineCommand(script.command, { lua });
  }

  return {
    algorithm,

    // checks: [{ limit, id }], where limit comes from compileLimit() and id is
    // a user id or an IP key. `now` (milliseconds) is for tests only;
    // normally the Redis server's clock decides.
    async check(checks, { now } = {}) {
      const keys = checks.map(({ limit, id }) => `${script.keyPrefix}:${limit.name}:${id}`);
      const args = checks.flatMap(({ limit }) => script.args(limit));
      const reply = await redis[script.command](keys.length, ...keys, now ?? "", ...args);

      return {
        allowed: reply[0] === 1,
        results: checks.map(({ limit }, i) => ({
          limit,
          remaining: reply[1 + 3 * i],
          retryAfterMs: reply[2 + 3 * i],
          resetAfterMs: reply[3 + 3 * i],
        })),
      };
    },
  };
}
