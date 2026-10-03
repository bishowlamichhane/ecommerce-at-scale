import "./env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import app from "../app.js";
import connectDB, { closeDB, query } from "../db/db.js";
import redis, { cacheRedis, waitForRedis } from "../utils/redisClient.js";
import { catalogCache } from "../utils/catalogCache.js";
import { ensureTestDatabase } from "./helpers.js";

// The products API's read endpoints with the catalog cache wired in: what
// gets cached, under which key, and what the Cache-Status header says.

let server;
let base;

before(async () => {
  await ensureTestDatabase();
  await connectDB({ handleSignals: false });
  assert.ok(await waitForRedis(cacheRedis), "Redis isn't reachable: docker compose up -d redis");
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await closeDB();
  redis.disconnect();
  cacheRedis.disconnect();
});

beforeEach(async () => {
  await query("TRUNCATE products, reservations, sales RESTART IDENTITY");
  await query(`INSERT INTO products (name, price, stock) SELECT 'Item ' || n, 10 + n, 5 FROM generate_series(1, 30) AS n`);
  await catalogCache().invalidate();
});

const get = async (path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, cache: res.headers.get("cache-status"), body: await res.json() };
};

describe("product list", () => {
  it("caches a page: miss, then hit", async () => {
    const first = await get("/get-products?limit=20&skip=0");
    assert.equal(first.cache, "catalog; fwd=uri-miss; stored");
    assert.equal(first.body.message.length, 20);

    const second = await get("/get-products?limit=20&skip=0");
    assert.match(second.cache, /^catalog; hit; ttl=\d+$/);
    assert.deepEqual(second.body.message, first.body.message);
  });

  it("treats the same page asked in a different order as the same page", async () => {
    await get("/get-products?limit=20&skip=0");
    assert.match((await get("/get-products?skip=0&limit=20")).cache, /hit/);
  });

  it("sends unbounded, oversized and invalid pages straight to Postgres", async () => {
    const cases = [
      ["/get-products", 200], // every product, as search's /sync asks
      ["/get-products?limit=500&skip=0", 200],
      ["/get-products?limit=20&skip=20000", 200],
      ["/get-products?limit=20&skip=-1", 400], // Postgres rejects a negative OFFSET
    ];
    for (const [path, status] of cases) {
      const res = await get(path);
      assert.equal(res.status, status, path);
      assert.equal(res.cache, "catalog; fwd=bypass; detail=not-cacheable", path);
    }
    assert.equal((await get("/get-products")).body.message.length, 30, "no limit still means every product");
  });

  it("shows a change on the next read, without waiting for the TTL", async () => {
    await get("/get-products?limit=20&skip=0");
    await query("UPDATE products SET name = 'Renamed' WHERE id = 1");
    await catalogCache().invalidate(); // what every write endpoint does
    const after = await get("/get-products?limit=20&skip=0");
    assert.equal(after.cache, "catalog; fwd=uri-miss; stored");
    assert.equal(after.body.message[0].name, "Renamed");
  });
});

describe("writes", () => {
  // RabbitMQ isn't connected in these tests, so each write's event publish
  // fails after the database write and the endpoint answers 400. The cache
  // is invalidated before the publish, so the change shows at once anyway.
  const send = (method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("adding a product shows on the next read", async () => {
    await get("/get-products?limit=50&skip=0");
    await send("POST", "/add-product", { name: "Added", price: 5 });
    const page = await get("/get-products?limit=50&skip=0");
    assert.equal(page.cache, "catalog; fwd=uri-miss; stored");
    assert.equal(page.body.message.length, 31);
  });

  it("changing a product's image shows on the next read", async () => {
    await get("/get-product-by-id/1");
    await send("PATCH", "/update-product", { productId: 1, image: "https://example.com/new.jpg" });
    const item = await get("/get-product-by-id/1");
    assert.equal(item.cache, "catalog; fwd=uri-miss; stored");
    assert.equal(item.body.message.image, "https://example.com/new.jpg");
  });

  it("deleting a product shows on the next read", async () => {
    assert.equal((await get("/get-product-by-id/2")).status, 200);
    await send("DELETE", "/remove-product/2");
    assert.equal((await get("/get-product-by-id/2")).status, 404);
  });

  it("deleting every product leaves the rest of Redis alone", async () => {
    // Stands for the rate limits, sale counters, reservations and job queues
    // that the old `flushall` wiped.
    await redis.set("rl:test-bucket", "kept");
    await get("/get-products?limit=50&skip=0");
    await send("DELETE", "/remove-all-products");
    assert.deepEqual((await get("/get-products?limit=50&skip=0")).body.message, []);
    assert.equal(await redis.get("rl:test-bucket"), "kept");
    await redis.del("rl:test-bucket");
  });
});

describe("single product", () => {
  it("caches it under its canonical id: /7 and /007 share one entry", async () => {
    assert.equal((await get("/get-product-by-id/7")).cache, "catalog; fwd=uri-miss; stored");
    const padded = await get("/get-product-by-id/007");
    assert.match(padded.cache, /hit/);
    assert.equal(padded.body.message.id, 7);
  });

  it("caches 'not found' too", async () => {
    const first = await get("/get-product-by-id/999");
    assert.equal(first.status, 404);
    const second = await get("/get-product-by-id/999");
    assert.equal(second.status, 404);
    assert.match(second.cache, /hit/);
  });

  it("finds a product created after a cached 'not found'", async () => {
    await get("/get-product-by-id/31");
    await query("INSERT INTO products (name, price) VALUES ('New', 1)"); // gets id 31
    await catalogCache().invalidate();
    const res = await get("/get-product-by-id/31");
    assert.equal(res.status, 200);
    assert.equal(res.body.message.name, "New");
  });

  it("leaves ids that aren't plain digits to Postgres, which answers as it always did", async () => {
    const cases = [
      ["abc", 400], // invalid input syntax for type integer
      ["7.5", 400],
      ["1e3", 400], // Number("1e3") is 1000; Postgres rejects it, and so do we
      ["0x10", 200], // Postgres 16+ reads hex input: product 16
      ["0", 404],
      ["-3", 404],
      ["2147483648", 400], // one past Postgres' integer range
    ];
    for (const [id, status] of cases) {
      const res = await get(`/get-product-by-id/${id}`);
      assert.equal(res.status, status, id);
      assert.equal(res.cache, "catalog; fwd=bypass; detail=not-cacheable", id);
    }
    assert.equal((await get("/get-product-by-id/0x10")).body.message.id, 16);
  });
});
