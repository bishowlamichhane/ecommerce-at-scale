import { query, withTransaction } from "../db/db.js";
import ApiError from "../utils/ApiError.js";

// Stock rules, in Postgres. `stock IS NULL` means the product doesn't track
// stock (the seed data has none), so it can always be bought.
//
// Each reserve function takes every item of an order or none of them: a
// throw inside withTransaction rolls the whole thing back.

const soldOut = (productId) => new ApiError(409, `Not enough stock for product ${productId}`);
const notFound = (productId) => new ApiError(404, `Product ${productId} not found`);

// Items arrive as [{ productId, quantity }]. Duplicates are merged so a
// product can't be checked twice against the same stock, and sorting by id
// means every order locks rows in the same sequence, so two orders can't
// deadlock each other.
export const normalizeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0)
    throw new ApiError(400, "items must be a non-empty array");

  const quantities = new Map();
  for (const item of items) {
    const productId = Number(item?.productId);
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity <= 0)
      throw new ApiError(400, "every item needs an integer productId and a positive integer quantity");
    quantities.set(productId, (quantities.get(productId) || 0) + quantity);
  }
  return [...quantities]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId - b.productId);
};

const insertReservation = (client, reservationId, status, items) =>
  client.query(
    "INSERT INTO reservations (id, status, items) VALUES ($1, $2, $3)",
    [reservationId, status, JSON.stringify(items)]
  );

// naive: read the stock, check it in code, write back the computed value.
// The transaction doesn't save it. At Postgres's default isolation level
// (READ COMMITTED) two buyers can both read 1 and both write 0: a lost update.
export const reserveNaive = (reservationId, items) =>
  withTransaction(async (client) => {
    const stocks = [];
    for (const { productId, quantity } of items) {
      const { rows } = await client.query("SELECT stock FROM products WHERE id = $1", [productId]);
      if (!rows[0]) throw notFound(productId);
      if (rows[0].stock !== null && rows[0].stock < quantity) throw soldOut(productId);
      stocks.push(rows[0].stock);
    }

    for (const [i, { productId, quantity }] of items.entries()) {
      if (stocks[i] === null) continue;
      await client.query(
        "UPDATE products SET stock = $2, updated_at = now() WHERE id = $1",
        [productId, stocks[i] - quantity]
      );
    }
    await insertReservation(client, reservationId, "reserved", items);
  });

// postgres: one statement checks and takes the stock. Concurrent buyers
// queue on the row lock, and each re-checks `stock >= quantity` against the
// newest version of the row once it gets the lock.
export const reservePostgres = (reservationId, items) =>
  withTransaction(async (client) => {
    for (const { productId, quantity } of items) {
      const { rowCount } = await client.query(
        `UPDATE products SET stock = stock - $2, updated_at = now()
         WHERE id = $1 AND (stock IS NULL OR stock >= $2)`,
        [productId, quantity]
      );
      if (rowCount === 0) {
        const { rowCount: exists } = await client.query("SELECT 1 FROM products WHERE id = $1", [productId]);
        throw exists ? soldOut(productId) : notFound(productId);
      }
    }
    await insertReservation(client, reservationId, "reserved", items);
  });

// postgres-lock: lock the rows first (SELECT … FOR UPDATE), then check and
// write. Also correct, but each buyer holds the lock while it checks, even
// when the answer is "sold out".
export const reservePostgresLock = (reservationId, items) =>
  withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id, stock FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
      [items.map((item) => item.productId)]
    );
    const stockById = new Map(rows.map((row) => [row.id, row.stock]));

    for (const { productId, quantity } of items) {
      if (!stockById.has(productId)) throw notFound(productId);
      const stock = stockById.get(productId);
      if (stock !== null && stock < quantity) throw soldOut(productId);
    }
    for (const { productId, quantity } of items) {
      await client.query(
        "UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1 AND stock IS NOT NULL",
        [productId, quantity]
      );
    }
    await insertReservation(client, reservationId, "reserved", items);
  });

// 'reserved', 'committed', 'released', or 'unknown' when there's no such row.
export const reservationStatus = async (reservationId) => {
  const { rows } = await query("SELECT status FROM reservations WHERE id = $1", [reservationId]);
  return rows[0]?.status ?? "unknown";
};

// The order exists, so the reservation is final. Only a 'reserved' row can
// change, which makes repeating it safe. Returns the outcome: 'committed'
// (now or before), or 'released' / 'unknown' when there's nothing to commit.
export const commitDbReservation = async (reservationId) => {
  const { rowCount } = await query(
    `UPDATE reservations SET status = 'committed', updated_at = now()
     WHERE id = $1 AND status = 'reserved'`,
    [reservationId]
  );
  return rowCount === 1 ? "committed" : reservationStatus(reservationId);
};

// There's no order, so the stock goes back. Same rule: only a 'reserved' row
// changes. Returns 'released' (now or before), or 'committed' when an order
// already owns the stock, or 'unknown'.
export const releaseDbReservation = async (reservationId) => {
  const released = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE reservations SET status = 'released', updated_at = now()
       WHERE id = $1 AND status = 'reserved'
       RETURNING items`,
      [reservationId]
    );
    if (!rows[0]) return false;

    for (const { productId, quantity } of rows[0].items) {
      await client.query(
        "UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1 AND stock IS NOT NULL",
        [productId, quantity]
      );
    }
    return true;
  });
  return released ? "released" : reservationStatus(reservationId);
};

// Reservations still open after `olderThanMs`, oldest first: the order they
// were made for either crashed or is about to commit (the sweeper asks the
// orders database which).
export const staleDbReservations = async (olderThanMs, limit) => {
  const { rows } = await query(
    `SELECT id, (extract(epoch FROM now() - created_at) * 1000)::bigint AS age_ms
     FROM reservations
     WHERE status = 'reserved' AND created_at < now() - make_interval(secs => $1 / 1000.0)
     ORDER BY created_at
     LIMIT $2`,
    [olderThanMs, limit]
  );
  return rows.map((row) => ({ reservationId: row.id, state: "reserved", ageMs: Number(row.age_ms) }));
};

export const openDbReservations = async (productId) => {
  const { rows } = await query(
    "SELECT count(*)::int AS n FROM reservations WHERE status = 'reserved' AND items @> $1::jsonb",
    [JSON.stringify([{ productId }])]
  );
  return rows[0].n;
};

// Redis mode: Redis already took the stock; this brings Postgres up to date
// once the order exists. The reservation id works as an idempotency key: if
// the row is already there, this commit was applied before and nothing
// changes. There's no stock check here because Redis made the decision. If
// Postgres had somehow drifted below zero, CHECK (stock >= 0) would fail and
// roll the whole commit back.
export const applyRedisCommit = (reservationId, items) =>
  withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO reservations (id, status, items) VALUES ($1, 'committed', $2)
       ON CONFLICT (id) DO NOTHING`,
      [reservationId, JSON.stringify(items)]
    );
    if (rowCount === 0) return false;

    for (const { productId, quantity } of items) {
      await client.query(
        "UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1 AND stock IS NOT NULL",
        [productId, quantity]
      );
    }
    return true;
  });

// id → stock (null when not tracked), for loading Redis.
export const getStocks = async (productIds) => {
  const { rows } = await query("SELECT id, stock FROM products WHERE id = ANY($1::int[])", [productIds]);
  return new Map(rows.map((row) => [row.id, row.stock]));
};
