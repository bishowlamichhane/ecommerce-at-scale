import { query, withTransaction } from "../db/db.js";

// Table definitions: ../db/schema.sql

const ORDER_COLUMNS = `id, user_id, billing_address, shipping_address,
  total_price AS "totalPrice", status, created_at AS "createdAt", updated_at AS "updatedAt"`;

// Writes the order and its items in one transaction, so an order can never
// exist without its items.
//
// Like the Mongoose schema, this only knows `user_id`. The controller passes
// `userId`, so every order still gets the default user (project 1 fixes it).
// A missing value would be sent as NULL rather than the column default,
// hence the COALESCE.
export const createOrder = ({ user_id, billing_address, shipping_address, totalPrice, items }) =>
  withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO orders (user_id, billing_address, shipping_address, total_price)
       VALUES (COALESCE($1, 'user123'), $2, $3, $4)
       RETURNING ${ORDER_COLUMNS}`,
      [user_id, billing_address, shipping_address, totalPrice]
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
