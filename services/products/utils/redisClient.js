import Redis from "ioredis";

// The products service's Redis: the listing cache and, in redis checkout
// mode, the sale's stock counters and reservations. REDIS_DB lets the tests
// work in a database of their own.
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  db: Number(process.env.REDIS_DB || 0),
});

redis.on("connect", () => console.log("🚀 Redis Connected (Product Service)"));
redis.on("error", (err) => console.error("❌ Redis Error:", err));


export default redis;
