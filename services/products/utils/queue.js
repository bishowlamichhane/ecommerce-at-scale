// BullMQ settings. The products and orders services share two queues in
// Redis, and each one only processes its own:
//   inventory  processed by this service's worker (worker.js): commit-stock
//   orders     processed by the orders service: confirm-order, reconcile
export const INVENTORY_QUEUE = "inventory";

export const redisConnection = () => ({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  db: Number(process.env.REDIS_DB || 0),
});
