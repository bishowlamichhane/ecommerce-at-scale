import { findStalePendingOrders, reservationsWithOrders } from "../models/Order.model.js";
import { releaseStock, staleReservations } from "../utils/inventory.js";
import {
  commitJobId,
  confirmJobId,
  enqueueOrderFlow,
  getInventoryQueue,
  getOrdersQueue,
} from "../utils/queues.js";

// The safety net, run every RECONCILE_EVERY_MS by the orders worker.
//
// The fast path (a job flow queued as soon as an order is saved) handles
// almost every order. This sweep catches the rest, starting from the
// databases, which are the source of truth:
//
//   1. Orders still Pending after PENDING_GRACE_MS. Their flow was never
//      queued (Redis was down), failed for good, or got lost: queue it again,
//      or retry the job that failed.
//   2. Reservations still open after STALE_RESERVATION_MS with no order
//      behind them. Orders crashed between reserving and saving: give the
//      stock back. A reservation that has an order is left alone; case 1
//      finishes it.
//
// Every action is idempotent, so two sweeps (or a sweep racing the fast
// path) can't double anything.

export const settingsFromEnv = (env = process.env) => ({
  pendingGraceMs: Number(env.PENDING_GRACE_MS || 60_000),
  staleReservationMs: Number(env.STALE_RESERVATION_MS || 120_000),
});

// The real dependencies; tests pass fakes with the same shape.
export const defaultDeps = {
  findStalePendingOrders,
  reservationsWithOrders,
  staleReservations,
  releaseStock,
  enqueueOrderFlow,
  jobState: (queue, jobId) => queueFor(queue).getJobState(jobId),
  retryJob: async (queue, jobId) => (await queueFor(queue).getJob(jobId))?.retry("failed"),
  removeJob: (queue, jobId) => queueFor(queue).remove(jobId, { removeChildren: true }),
};
const queueFor = (name) => (name === "orders" ? getOrdersQueue() : getInventoryQueue());

export async function reconcile(settings, deps = defaultDeps) {
  const summary = { flowsQueued: 0, jobsRetried: 0, reservationsReleased: 0, anomalies: [] };

  // 1. Pending orders that should have been confirmed by now.
  for (const order of await deps.findStalePendingOrders(settings.pendingGraceMs)) {
    const parentId = confirmJobId(order.id);
    const childId = commitJobId(order.reservationId);
    const parent = await deps.jobState("orders", parentId);
    const child = await deps.jobState("inventory", childId);

    if (parent === "unknown") {
      // Never queued, or lost. A leftover child would block re-adding it
      // under the same id, so clear it first.
      if (child !== "unknown") await deps.removeJob("inventory", childId);
      await deps.enqueueOrderFlow({ orderId: order.id, reservationId: order.reservationId });
      summary.flowsQueued += 1;
    } else if (parent === "failed") {
      await deps.retryJob("orders", parentId);
      summary.jobsRetried += 1;
    } else if (child === "failed") {
      // The parent waits for its child; once the retried child completes,
      // the parent runs.
      await deps.retryJob("inventory", childId);
      summary.jobsRetried += 1;
    } else if (parent === "waiting-children" && child === "unknown") {
      // The child vanished, so the parent would wait forever: rebuild the flow.
      await deps.removeJob("orders", parentId);
      await deps.enqueueOrderFlow({ orderId: order.id, reservationId: order.reservationId });
      summary.flowsQueued += 1;
    } else if (parent === "completed") {
      // confirm-order only completes after moving the order out of Pending.
      summary.anomalies.push(`order ${order.id} is Pending but its confirm job completed`);
    }
    // Anything else (waiting, delayed, active...) is still on its way.
  }

  // 2. Stock held by reservations that no order will ever claim.
  const stale = await deps.staleReservations(settings.staleReservationMs);
  if (stale.length > 0) {
    const owned = await deps.reservationsWithOrders(stale.map((r) => r.reservationId));
    for (const { reservationId } of stale) {
      if (owned.has(reservationId)) continue;
      const status = await deps.releaseStock(reservationId);
      if (status === "released") summary.reservationsReleased += 1;
      else if (status === "committing" || status === "committed")
        summary.anomalies.push(`reservation ${reservationId} has no order but is ${status}`);
    }
  }

  return summary;
}
