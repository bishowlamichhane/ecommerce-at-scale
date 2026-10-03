import { createRedisClient } from "../redisClient.js";

// Tests use Redis database 15, so they never touch the app's data
// (database 0), and random ids, so one test can't see another's keys.

export const silentLogger = { log() {}, warn() {} };

// A logger that remembers warnings, for tests that expect one.
export function recordingLogger() {
  const warnings = [];
  return { warnings, log() {}, warn: (message) => warnings.push(message) };
}

export const uid = (label) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

export function testRedis() {
  const redis = createRedisClient({ host: process.env.REDIS_HOST || "localhost", port: 6379, db: 15 }, silentLogger);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      redis.disconnect();
      reject(new Error("Redis isn't reachable on localhost:6379. Start it: docker compose up -d redis"));
    }, 3000);
    redis.once("ready", () => {
      clearTimeout(timer);
      resolve(redis);
    });
  });
}

// A client pointed at a port where nothing listens: Redis "down".
export const deadRedis = () => createRedisClient({ host: "127.0.0.1", port: 1 }, silentLogger);
