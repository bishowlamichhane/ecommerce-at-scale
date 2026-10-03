import { FlowProducer, Queue } from "bullmq";

// BullMQ settings. The orders and products services share two queues in
// Redis, and each one only processes its own:
//   orders     processed by this service's worker (worker.js): confirm-order, reconcile
//   inventory  processed by the products service's worker: commit-stock
export const ORDERS_QUEUE = "orders";
export const INVENTORY_QUEUE = "inventory";

export const redisConnection = () => ({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
  db: Number(process.env.REDIS_DB || 0),
});

// Producers (the API adding jobs) fail fast when Redis is down instead of
// holding commands in memory and making the buyer wait. The order is already
// safe in Postgres; the sweeper queues its jobs once Redis is back.
const producerConnection = () => ({ ...redisConnection(), enableOfflineQueue: false, commandTimeout: 1000 });

// Job ids double as idempotency keys: adding a job whose id already exists
// is a no-op, so queueing the same flow twice does no harm. BullMQ ids can't
// contain ':'.
export const confirmJobId = (orderId) => `confirm-${orderId}`;
export const commitJobId = (reservationId) => `commit-${reservationId}`;

// Retries with exponential backoff (1 s, 2 s, 4 s ... about 2 minutes over
// 8 attempts) ride out a database or Redis blip. Finished jobs are kept for
// a while, so Bull Board can show them.
export const JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

let flows;
let ordersQueue;
let inventoryQueue;
export const getFlowProducer = () => (flows ??= new FlowProducer({ connection: producerConnection() }));
export const getOrdersQueue = () => (ordersQueue ??= new Queue(ORDERS_QUEUE, { connection: producerConnection() }));
export const getInventoryQueue = () => (inventoryQueue ??= new Queue(INVENTORY_QUEUE, { connection: producerConnection() }));

// The order is saved: make its stock final (commit-stock, on the products
// worker), then confirm or cancel the order (confirm-order, on this
// service's worker). BullMQ holds a parent until all its children completed.
export function enqueueOrderFlow({ orderId, reservationId }) {
  return getFlowProducer().add({
    name: "confirm-order",
    queueName: ORDERS_QUEUE,
    data: { orderId },
    opts: { jobId: confirmJobId(orderId), ...JOB_OPTIONS },
    children: [
      {
        name: "commit-stock",
        queueName: INVENTORY_QUEUE,
        data: { reservationId },
        opts: { jobId: commitJobId(reservationId), ...JOB_OPTIONS },
      },
    ],
  });
}

export async function closeQueues() {
  await Promise.all([flows?.close(), ordersQueue?.close(), inventoryQueue?.close()]);
}
