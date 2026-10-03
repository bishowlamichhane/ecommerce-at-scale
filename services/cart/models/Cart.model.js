import { query, withTransaction } from "../db/db.js";

// Table definitions: ../db/schema.sql
//
// The cart is handled like the Mongo document it used to be: the controller
// edits a plain object in memory, and saveCart() writes the cart row and all
// of its items in one transaction. Each shopper (userId) has one cart.

// Mongo left unset fields out of a document; Postgres returns them as null.
const dropNulls = (row) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

// `db` is the pool's query() or a transaction client: both have .query().
const readCart = async (db, column, value) => {
  const { rows } = await db.query(
    `SELECT id, user_id AS "userId", total_price AS "totalPrice",
       created_at AS "createdAt", updated_at AS "updatedAt"
     FROM carts WHERE ${column} = $1`,
    [value]
  );
  if (!rows[0]) return null;

  const items = await db.query(
    `SELECT id, product_id AS "productId", name, price, quantity, description, image
     FROM cart_items WHERE cart_id = $1 ORDER BY id`,
    [rows[0].id]
  );
  return { ...rows[0], items: items.rows.map(dropNulls) };
};

export const findCart = (userId) => readCart({ query }, "user_id", userId);

export const saveCart = (cart, userId) =>
  withTransaction(async (client) => {
    // Upsert on user_id: if two first-time requests from the same shopper
    // race, both end up writing the same cart instead of one failing.
    const { rows } = await client.query(
      `INSERT INTO carts (user_id, total_price) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET total_price = EXCLUDED.total_price, updated_at = now()
       RETURNING id`,
      [userId, cart.totalPrice]
    );
    const cartId = rows[0].id;

    // Replace the items wholesale, like saving a Mongo document did.
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
    for (const item of cart.items) {
      await client.query(
        `INSERT INTO cart_items (cart_id, product_id, name, price, quantity, description, image)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [cartId, item.productId, item.name, item.price, item.quantity, item.description, item.image]
      );
    }

    return readCart(client, "id", cartId);
  });

// Like Mongo's findOneAndDelete(): returns the cart it deleted, or null.
export const deleteCart = (userId) =>
  withTransaction(async (client) => {
    const cart = await readCart(client, "user_id", userId);
    if (cart) await client.query("DELETE FROM carts WHERE id = $1", [cart.id]);
    return cart;
  });
