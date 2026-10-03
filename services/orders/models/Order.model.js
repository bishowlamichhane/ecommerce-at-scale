import { query, withTransaction } from "../db/db.js";

// Table definitions: ../db/schema.sql
//
// An order's life (phase 3):
//   Pending     saved, its stock reserved; the job flow is making it final
//   Processing  confirmed: the stock is committed and the customer emailed
//   Cancelled   the stock couldn't be committed, so the order can't ship

const ORDER_COLUMNS = `id, user_id, billing_address, shipping_address,
  total_price AS "totalPrice", status, created_at AS "createdAt", updated_at AS "updatedAt"`;

// Writes the order and its items in one transaction, so an order can never
// exist without its items.
//
// A missing user_id would be sent as NULL rather than the column default,
// hence the COALESCE. reservation_id is unique: one reservation can never
// pay for two orders.
export const createOrder = ({ user_id, reservation_id, billing_address, shipping_address, totalPrice, items }) =>
  withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO orders (user_id, reservation_id, billing_address, shipping_address, total_price)
       VALUES (COALESCE($1, 'user123'), $2, $3, $4, $5)
       RETURNING ${ORDER_COLUMNS}`,
      [user_id, reservation_id, billing_address, shipping_address, totalPrice]
    );
    const order = rows[0];

    order.items = [];
    for (const item of items) {
      const inserted = await client.query(
        `INSERT INTO order_items (order_id, product_id, name, price, quantity)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, product_id AS "productId", name, price, quantity`,
        // The cart's products carry the product id as `id`.
        [order.id, item.id, item.name, item.price, item.quantity]
      );
      order.items.push(inserted.rows[0]);
    }
    return order;
  });

export const findOrderById = async (id) => {
  const { rows } = await query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [id]);
  return rows[0];
};

// A shopper's latest orders, newest first, each with its items.
export const findOrdersByUser = async (userId, limit = 20) => {
  const { rows } = await query(
    `SELECT o.id, o.status, o.total_price AS "totalPrice",
            o.created_at AS "createdAt", o.updated_at AS "updatedAt",
            COALESCE(
              json_agg(json_build_object('productId', i.product_id, 'name', i.name,
                                         'price', i.price, 'quantity', i.quantity) ORDER BY i.id)
                FILTER (WHERE i.id IS NOT NULL),
              '[]') AS items
     FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
     WHERE o.user_id = $1
     GROUP BY o.id
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

export const findNotificationsByUser = async (userId, limit = 20) => {
  const { rows } = await query(
    `SELECT id, order_id AS "orderId", kind, subject, body, created_at AS "createdAt"
     FROM notifications WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
};

// Orders still Pending after `olderThanMs`: their job flow never ran, failed
// or got lost. Orders from before phase 3 have no reservation and are left alone.
export const findStalePendingOrders = async (olderThanMs, limit = 100) => {
  const { rows } = await query(
    `SELECT id, reservation_id AS "reservationId"
     FROM orders
     WHERE status = 'Pending' AND reservation_id IS NOT NULL
       AND created_at < now() - make_interval(secs => $1 / 1000.0)
     ORDER BY created_at
     LIMIT $2`,
    [olderThanMs, limit]
  );
  return rows;
};

// Which of these reservations have an order.
export const reservationsWithOrders = async (reservationIds) => {
  if (reservationIds.length === 0) return new Set();
  const { rows } = await query(
    "SELECT reservation_id FROM orders WHERE reservation_id = ANY($1::text[])",
    [reservationIds]
  );
  return new Set(rows.map((row) => row.reservation_id));
};

const itemList = (items) => items.map((item) => `${item.quantity} × ${item.name}`).join(", ");

const MESSAGES = {
  "order-confirmed": ({ order, items }) => ({
    subject: `Order #${order.id} is confirmed`,
    body: `Good news! Your order for ${itemList(items)} ($${Number(order.total_price).toFixed(2)}) is confirmed and being prepared.`,
  }),
  "order-cancelled": ({ order, items }) => ({
    subject: `Order #${order.id} couldn't be completed`,
    body: `Sorry: the stock for ${itemList(items)} ran out before your order could be confirmed. You haven't been charged.`,
  }),
};

// Moves a Pending order to its final status and writes the matching
// notification, in one transaction.
//
// The status change is a single conditional UPDATE, the same pattern that
// stopped overselling in phase 1: only one run can move the order out of
// Pending. A second run, whether a retry or overlapping, finds nothing to
// update and changes nothing, so the email goes out once.
// Returns { status, changed }; status is "missing" if the order was deleted.
const finishOrder = (orderId, status, kind) =>
  withTransaction(async (client) => {
    const { rows: [order] } = await client.query(
      `UPDATE orders SET status = $2, updated_at = now()
       WHERE id = $1 AND status = 'Pending'
       RETURNING id, user_id, total_price`,
      [orderId, status]
    );
    if (!order) {
      const { rows: [current] } = await client.query("SELECT status FROM orders WHERE id = $1", [orderId]);
      return { status: current?.status ?? "missing", changed: false };
    }

    const { rows: items } = await client.query(
      "SELECT name, quantity FROM order_items WHERE order_id = $1 ORDER BY id",
      [orderId]
    );
    const message = MESSAGES[kind]({ order, items });
    await client.query(
      `INSERT INTO notifications (user_id, order_id, kind, subject, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id, kind) DO NOTHING`,
      [order.user_id, orderId, kind, message.subject, message.body]
    );
    return { status, changed: true };
  });

export const confirmOrder = (orderId) => finishOrder(orderId, "Processing", "order-confirmed");
export const cancelOrder = (orderId) => finishOrder(orderId, "Cancelled", "order-cancelled");
