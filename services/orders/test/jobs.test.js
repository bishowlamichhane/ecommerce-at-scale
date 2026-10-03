import "./env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import connectDB, { closeDB, query } from "../db/db.js";
import { ensureTestDatabase, uid } from "./helpers.js";
import {
  createOrder,
  findOrdersByUser,
  findStalePendingOrders,
  reservationsWithOrders,
} from "../models/Order.model.js";
import { processConfirmOrder } from "../jobs/confirmOrder.js";
import { reconcile } from "../jobs/reconcile.js";
import { commitJobId, confirmJobId } from "../utils/queues.js";

// The orders side of the job flow, against a real Postgres test database:
// confirm-order's outcomes and idempotency, and every case the sweeper handles.

before(async () => {
  await ensureTestDatabase();
  await connectDB({ handleSignals: false });
});

after(() => closeDB());

beforeEach(() => query("TRUNCATE orders RESTART IDENTITY CASCADE"));

const ITEM = { id: 7, name: "Test Sneakers", price: 99.99, quantity: 1 };

const placeOrder = (overrides = {}) =>
  createOrder({
    user_id: "alice",
    reservation_id: uid("resv"),
    billing_address: "KTM",
    shipping_address: "KTM",
    totalPrice: 99.99,
    items: [ITEM],
    ...overrides,
  });

const ageOrder = (orderId, minutes) =>
  query(`UPDATE orders SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [orderId, minutes]);

const statusOf = async (orderId) => (await query("SELECT status FROM orders WHERE id = $1", [orderId])).rows[0]?.status;
const mailFor = async (orderId) =>
  (await query("SELECT kind FROM notifications WHERE order_id = $1 ORDER BY id", [orderId])).rows.map((r) => r.kind);

// A stand-in for a BullMQ job whose commit-stock child reported `status`.
const confirmJob = (orderId, ...childStatuses) => ({
  data: { orderId },
  getChildrenValues: async () =>
    Object.fromEntries(childStatuses.map((status, i) => [`bull:inventory:child-${i}`, { status }])),
});

describe("orders", () => {
  it("records the reservation behind each order, and one reservation can't pay twice", async () => {
    const order = await placeOrder({ reservation_id: "resv-unique" });
    assert.equal(
      (await query("SELECT reservation_id FROM orders WHERE id = $1", [order.id])).rows[0].reservation_id,
      "resv-unique"
    );
    await assert.rejects(placeOrder({ reservation_id: "resv-unique" }), /duplicate key/);
  });

  it("lists a shopper's own orders, newest first, with their items", async () => {
    const first = await placeOrder();
    const second = await placeOrder();
    await placeOrder({ user_id: "bob" });
    const mine = await findOrdersByUser("alice");
    assert.deepEqual(mine.map((o) => o.id), [second.id, first.id]);
    assert.deepEqual(mine[0].items, [{ productId: 7, name: "Test Sneakers", price: 99.99, quantity: 1 }]);
  });
});

describe("confirm-order job", () => {
  it("confirms the order and sends one email once the stock is committed", async () => {
    const order = await placeOrder();
    const result = await processConfirmOrder(confirmJob(order.id, "committed"));
    assert.deepEqual(result, { orderId: order.id, status: "Processing", changed: true });
    assert.equal(await statusOf(order.id), "Processing");
    assert.deepEqual(await mailFor(order.id), ["order-confirmed"]);
  });

  it("changes nothing when it runs again (a retry)", async () => {
    const order = await placeOrder();
    await processConfirmOrder(confirmJob(order.id, "committed"));
    const again = await processConfirmOrder(confirmJob(order.id, "committed"));
    assert.deepEqual(again, { orderId: order.id, status: "Processing", changed: false });
    assert.deepEqual(await mailFor(order.id), ["order-confirmed"], "still one email");
  });

  it("sends one email when runs overlap", async () => {
    // Open the connections first, so the runs really overlap instead of one
    // finishing while the next is still connecting.
    await Promise.all(Array.from({ length: 4 }, () => query("SELECT pg_sleep(0.05)")));
    for (let i = 0; i < 10; i++) {
      const order = await placeOrder();
      const runs = await Promise.all(
        Array.from({ length: 4 }, () => processConfirmOrder(confirmJob(order.id, "committed")))
      );
      assert.equal(runs.filter((r) => r.changed).length, 1, "exactly one run confirmed it");
      assert.deepEqual(await mailFor(order.id), ["order-confirmed"]);
    }
  });

  it("cancels the order and says so when the stock went back first", async () => {
    for (const childStatus of ["released", "unknown"]) {
      const order = await placeOrder();
      const result = await processConfirmOrder(confirmJob(order.id, childStatus));
      assert.equal(result.status, "Cancelled");
      assert.equal(await statusOf(order.id), "Cancelled");
      assert.deepEqual(await mailFor(order.id), ["order-cancelled"]);
    }
  });

  it("retries instead of cancelling when the child's result is missing", async () => {
    const order = await placeOrder();
    await assert.rejects(processConfirmOrder(confirmJob(order.id)), /no commit-stock result/);
    assert.equal(await statusOf(order.id), "Pending");
  });

  it("completes quietly for an order that was deleted meanwhile", async () => {
    const result = await processConfirmOrder(confirmJob(4242, "committed"));
    assert.deepEqual(result, { orderId: 4242, status: "missing", changed: false });
  });
});

describe("reconcile (the sweeper)", () => {
  const settings = { pendingGraceMs: 60_000, staleReservationMs: 120_000 };

  // Fakes for BullMQ and the products service that record what the sweeper did.
  function fakes({ jobs = {}, stale = [], releaseAnswer = "released" } = {}) {
    const calls = { queued: [], retried: [], removed: [], released: [] };
    const deps = {
      findStalePendingOrders,
      reservationsWithOrders,
      jobState: async (queue, id) => jobs[`${queue}/${id}`] ?? "unknown",
      retryJob: async (queue, id) => calls.retried.push(`${queue}/${id}`),
      removeJob: async (queue, id) => calls.removed.push(`${queue}/${id}`),
      enqueueOrderFlow: async ({ orderId }) => calls.queued.push(orderId),
      staleReservations: async () => stale,
      releaseStock: async (reservationId) => {
        calls.released.push(reservationId);
        return releaseAnswer;
      },
    };
    return { deps, calls };
  }

  const stalePendingOrder = async () => {
    const order = await placeOrder();
    await ageOrder(order.id, 5);
    const { rows } = await query("SELECT reservation_id FROM orders WHERE id = $1", [order.id]);
    return { ...order, reservationId: rows[0].reservation_id };
  };

  it("queues the flow of an order whose jobs were never queued", async () => {
    const order = await stalePendingOrder();
    const { deps, calls } = fakes();
    const summary = await reconcile(settings, deps);
    assert.deepEqual(calls.queued, [order.id]);
    assert.equal(summary.flowsQueued, 1);
  });

  it("leaves alone orders still inside the grace period, confirmed orders and pre-phase-3 orders", async () => {
    await placeOrder(); // fresh: its flow is probably running right now
    const confirmed = await placeOrder();
    await processConfirmOrder(confirmJob(confirmed.id, "committed"));
    await ageOrder(confirmed.id, 5);
    const legacy = await placeOrder({ reservation_id: null });
    await ageOrder(legacy.id, 5);

    const { deps, calls } = fakes();
    await reconcile(settings, deps);
    assert.deepEqual(calls, { queued: [], retried: [], removed: [], released: [] });
  });

  it("retries a failed confirm job, or a failed commit job its parent is waiting for", async () => {
    const a = await stalePendingOrder();
    const b = await stalePendingOrder();
    const { deps, calls } = fakes({
      jobs: {
        [`orders/${confirmJobId(a.id)}`]: "failed",
        [`orders/${confirmJobId(b.id)}`]: "waiting-children",
        [`inventory/${commitJobId(b.reservationId)}`]: "failed",
      },
    });
    const summary = await reconcile(settings, deps);
    assert.deepEqual(calls.retried, [`orders/${confirmJobId(a.id)}`, `inventory/${commitJobId(b.reservationId)}`]);
    assert.equal(summary.jobsRetried, 2);
  });

  it("rebuilds a flow whose child job vanished", async () => {
    const order = await stalePendingOrder();
    const { deps, calls } = fakes({ jobs: { [`orders/${confirmJobId(order.id)}`]: "waiting-children" } });
    await reconcile(settings, deps);
    assert.deepEqual(calls.removed, [`orders/${confirmJobId(order.id)}`]);
    assert.deepEqual(calls.queued, [order.id]);
  });

  it("leaves a flow alone while its jobs are queued, delayed or running", async () => {
    const order = await stalePendingOrder();
    for (const state of ["waiting", "delayed", "active"]) {
      const { deps, calls } = fakes({
        jobs: {
          [`orders/${confirmJobId(order.id)}`]: "waiting-children",
          [`inventory/${commitJobId(order.reservationId)}`]: state,
        },
      });
      await reconcile(settings, deps);
      assert.deepEqual(calls, { queued: [], retried: [], removed: [], released: [] }, state);
    }
  });

  it("releases stock held for orders that were never saved, and only that", async () => {
    const owned = await placeOrder();
    const { rows } = await query("SELECT reservation_id FROM orders WHERE id = $1", [owned.id]);
    const stale = [
      { reservationId: rows[0].reservation_id, state: "reserved" },
      { reservationId: "resv-orphan", state: "reserved" },
    ];
    const { deps, calls } = fakes({ stale });
    const summary = await reconcile(settings, deps);
    assert.deepEqual(calls.released, ["resv-orphan"]);
    assert.equal(summary.reservationsReleased, 1);
  });

  it("reports a reservation without an order that can't be released", async () => {
    const { deps } = fakes({ stale: [{ reservationId: "resv-odd", state: "committing" }], releaseAnswer: "committing" });
    const summary = await reconcile(settings, deps);
    assert.equal(summary.reservationsReleased, 0);
    assert.match(summary.anomalies[0], /resv-odd has no order but is committing/);
  });
});
