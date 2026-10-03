import redis from "./redisClient.js";

export async function clearProductCache() {
  const keys = await redis.keys("products:*");
  if (keys.length) await redis.del(keys);
}
