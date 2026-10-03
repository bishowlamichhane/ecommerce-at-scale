// Test harness for the flash sale. Run from services/products:
//
//   npm run sale:reset -- 10   one product with 10 units, none of its orders,
//                              no carts, no leftover Redis sale state
//   npm run sale:report        units sold vs units that existed
//
// It talks to the databases directly, so it's a dev tool, not an API.
// The cart and orders databases sit next to product_service on the same
// Postgres, so their URLs are derived from DATABASE_URL.

import pg from "pg";
import Redis from "ioredis";

const SALE_PRODUCT = {
  name: "Flash Sale Sneakers",
  price: 99.99,
  category: "Footwear",
  subcategory: "Shoes",
  gender: "Unisex",
  color: "Black",
  usage: "Casual",
  image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&h=800&q=80&fit=crop",
};

const dbUrl = (database) => {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
};

const products = new pg.Client({ connectionString: process.env.DATABASE_URL });
const orders = new pg.Client({ connectionString: dbUrl("orders_service") });
const carts = new pg.Client({ connectionString: dbUrl("cart_service") });
const redis = new Redis({ host: "localhost", port: 6379, lazyConnect: true });

const initialStockKey = (id) => `sale:${id}:initial`;

async function findSaleProductId() {
  const { rows } = await products.query("SELECT id FROM products WHERE name = $1 ORDER BY id LIMIT 1", [SALE_PRODUCT.name]);
  return rows[0]?.id;
}

async function deleteKeys(pattern) {
  for await (const keys of redis.scanStream({ match: pattern, count: 500 })) {
    if (keys.length > 0) await redis.del(...keys);
  }
}

async function reset(stock) {
  if (!Number.isInteger(stock) || stock < 0) throw new Error("usage: npm run sale:reset -- <stock>");

  let id = await findSaleProductId();
  if (!id) {
    const p = SALE_PRODUCT;
    const { rows } = await products.query(
      `INSERT INTO products (name, price, category, subcategory, gender, color, usage, image)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [p.name, p.price, p.category, p.subcategory, p.gender, p.color, p.usage, p.image]
    );
    id = rows[0].id;
  }
  await products.query("UPDATE products SET stock = $2, updated_at = now() WHERE id = $1", [id, stock]);

  await orders.query(
    "DELETE FROM orders WHERE id IN (SELECT order_id FROM order_items WHERE product_id = $1)",
    [id]
  );
  await carts.query("DELETE FROM carts");
  // The table appears once the products service has booted with phase 1's schema.
  const { rows: [table] } = await products.query("SELECT to_regclass('reservations') AS name");
  if (table.name)
    await products.query("DELETE FROM reservations WHERE items @> $1::jsonb", [JSON.stringify([{ productId: id }])]);

  await redis.del(`stock:${id}`);
  await deleteKeys("resv:*");
  await deleteKeys("products:*");
  // The gateway's rate-limit state: every run starts with full buckets, so the
  // previous run's bots can't affect this one.
  await deleteKeys("rl:*");
  await redis.set(initialStockKey(id), stock);

  console.log(`sale product ${id}: stock ${stock}, its orders and all carts cleared`);
  console.log(`PRODUCT_ID=${id}`);
}

async function report() {
  const id = await findSaleProductId();
  if (!id) throw new Error("no sale product yet: run sale:reset first");

  const initial = Number(await redis.get(initialStockKey(id)));
  const { rows: [product] } = await products.query("SELECT stock FROM products WHERE id = $1", [id]);
  const { rows: [sold] } = await orders.query(
    `SELECT count(DISTINCT order_id)::int AS orders, COALESCE(sum(quantity), 0)::int AS units
     FROM order_items WHERE product_id = $1`,
    [id]
  );
  const redisStock = await redis.get(`stock:${id}`);
  // Anything still open after a run is stock that's neither sold nor returned.
  const { rows: [open] } = await products.query(
    "SELECT count(*)::int AS n FROM reservations WHERE status = 'reserved' AND items @> $1::jsonb",
    [JSON.stringify([{ productId: id }])]
  );
  const openInRedis = await redis.zcard("resv:pending");
  // Who got the units: the bots-vs-humans load test names its bots "bot-…".
  const { rows: bySide } = await orders.query(
    `SELECT CASE WHEN o.user_id LIKE 'bot-%' THEN 'bots' ELSE 'humans' END AS side,
            COALESCE(sum(oi.quantity), 0)::int AS units
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_id = $1
     GROUP BY 1`,
    [id]
  );
  const soldTo = { humans: 0, bots: 0 };
  for (const row of bySide) soldTo[row.side] = row.units;

  console.log(JSON.stringify({
    productId: id,
    initialStock: initial,
    ordersCreated: sold.orders,
    unitsSold: sold.units,
    soldTo,
    oversold: Math.max(0, sold.units - initial),
    postgresStockNow: product.stock,
    redisStockNow: redisStock === null ? null : redisStock,
    openReservations: open.n + openInRedis,
  }, null, 2));
}

const [command, arg] = process.argv.slice(2);
try {
  await Promise.all([products.connect(), orders.connect(), carts.connect(), redis.connect()]);
  if (command === "reset") await reset(Number(arg));
  else if (command === "report") await report();
  else throw new Error("usage: flash-sale.js reset <stock> | report");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([products.end(), orders.end(), carts.end()]);
  redis.disconnect();
}
