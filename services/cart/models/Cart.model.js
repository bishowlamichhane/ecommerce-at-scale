import { query, withTransaction } from "../db/db.js";

// Table definitions: ../db/schema.sql
//
// The cart is handled like the Mongo document it used to be: the controller
// edits a plain object in memory, and saveCart() writes the cart row and all
// of its items in one transaction.

// Mongo left unset fields out of a document; Postgres returns them as null.
const dropNulls = (row) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

// `db` is the pool's query() or a transaction client: both have .query().
// Without a cartId it reads the first cart: the store still has one cart
// shared by everybody (project 1 fixes that).
const readCart = async (db, cartId) => {
  const select = `SELECT id, total_price AS "totalPrice",
    created_at AS "createdAt", updated_at AS "updatedAt" FROM carts`;
  const { rows } = cartId
    ? await db.query(`${select} WHERE id = $1`, [cartId])
    : await db.query(`${select} ORDER BY id LIMIT 1`);
  if (!rows[0]) return null;

  const items = await db.query(
    `SELECT id, product_id AS "productId", name, price, quantity, description, image
     FROM cart_items WHERE cart_id = $1 ORDER BY id`,
    [rows[0].id]
  );
  return { ...rows[0], items: items.rows.map(dropNulls) };
};

export const findCart = () => readCart({ query });

export const saveCart = (cart) =>
  withTransaction(async (client) => {
    let cartId = cart.id;
    if (cartId) {
      await client.query(
        "UPDATE carts SET total_price = $2, updated_at = now() WHERE id = $1",
        [cartId, cart.totalPrice]
      );
    } else {
      const { rows } = await client.query(
        "INSERT INTO carts (total_price) VALUES ($1) RETURNING id",
        [cart.totalPrice]
      );
      cartId = rows[0].id;
    }

    // Replace the items wholesale, like saving a Mongo document did.
    await client.query("DELETE FROM cart_items WHERE cart_id = $1", [cartId]);
    for (const item of cart.items) {
      await client.query(
        `INSERT INTO cart_items (cart_id, product_id, name, price, quantity, description, image)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [cartId, item.productId, item.name, item.price, item.quantity, item.description, item.image]
      );
    }

    return readCart(client, cartId);
  });

// Like Mongo's findOneAndDelete(): returns the cart it deleted, or null.
export const deleteFirstCart = () =>
  withTransaction(async (client) => {
    const cart = await readCart(client);
    if (cart) await client.query("DELETE FROM carts WHERE id = $1", [cart.id]);
    return cart;
  });
