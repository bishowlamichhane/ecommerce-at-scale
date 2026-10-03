import { cancelOrder, confirmOrder } from "../models/Order.model.js";

// confirm-order: the second step of an order's job flow. BullMQ only starts
// it once its child, commit-stock (run by the products worker), has
// completed, and hands it the child's result:
//   'committed'  the stock is final: confirm the order and email the buyer
//   anything else ('released', 'unknown'): the stock went back before the
//                order could claim it, e.g. the sweeper released it after a
//                crash, so the order can't ship: cancel it and say so
//
// Both outcomes are idempotent (see finishOrder), so retries are safe.
export async function processConfirmOrder(job) {
  const { orderId } = job.data;
  const results = Object.values(await job.getChildrenValues());
  // A flow always has its commit-stock child. If there's no result, retry
  // rather than cancel a paid order on a guess.
  if (results.length === 0) throw new Error(`Order ${orderId}: no commit-stock result yet`);

  const committed = results.every((result) => result?.status === "committed");
  const outcome = committed ? await confirmOrder(orderId) : await cancelOrder(orderId);
  return { orderId, ...outcome };
}
