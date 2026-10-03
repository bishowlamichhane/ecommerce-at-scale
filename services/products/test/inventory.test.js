import "./env.js";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import connectDB, { closeDB, query } from "../db/db.js";
import redis, { cacheRedis, waitForRedis } from "../utils/redisClient.js";
import { ensureTestDatabase, uid } from "./helpers.js";
import {
  commitReservation,
  releaseReservation,
  reserveStock,
  staleReservations,
  stockView,
} from "../utils/inventoryActions.js";
import { claimRedisReservation } from "../utils/inventoryRedis.js";

// The reservation life cycle in every checkout mode: commit and release are
// safe to repeat, can race each other, and survive a crash halfway through.
// Runs against real Postgres and Redis (test databases), not mocks.

const MODES = ["naive", "postgres", "postgres-lock", "redis"];
let productId;

before(async () => {
  await ensureTestDatabase();
  await connectDB({ handleSignals: false });
  // The clients don't queue commands while connecting, so wait for them.
  assert.ok(await waitForRedis(redis), "Redis isn't reachable: docker compose up -d redis");
});

after(async () => {
  await closeDB();
  redis.disconnect();
  cacheRedis.disconnect();
});

beforeEach(async () => {
  await query("TRUNCATE products, reservations, sales RESTART IDENTITY");
  await redis.flushdb();
  const { rows } = await query(
    "INSERT INTO products (name, price, stock) VALUES ('Test Sneakers', 99.99, 10) RETURNING id"
  );
  productId = rows[0].id;
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const postgresStock = async () => (await query("SELECT stock FROM products WHERE id = $1", [productId])).rows[0].stock;

// What the next buyer is checked against: the Redis counter in redis mode.
const liveStock = async () =>
  process.env.CHECKOUT_MODE === "redis" ? Number(await redis.get(`stock:${productId}`)) : postgresStock();

const reserve = async (quantity = 1) => {
  const id = uid("resv");
  await reserveStock(id, [{ productId, quantity }]);
  return id;
};

for (const mode of MODES) {
  describe(`inventory, ${mode} mode`, () => {
    beforeEach(() => {
      process.env.CHECKOUT_MODE = mode;
    });

    it("commits once, however many times it's asked", async () => {
      const id = await reserve(3);
      assert.equal(await commitReservation(id), "committed");
      assert.equal(await commitReservation(id), "committed", "a retried commit reports success");
      assert.equal(await postgresStock(), 7, "Postgres was charged once");
      assert.equal(await liveStock(), 7);
    });

    it("gives stock back once, and a released reservation can't be committed", async () => {
      const id = await reserve(3);
      assert.equal(await liveStock(), 7);
      assert.equal(await releaseReservation(id), "released");
      assert.equal(await liveStock(), 10);

      // Repeating it changes nothing; redis mode keeps no record of releases.
      const expected = mode === "redis" ? "unknown" : "released";
      assert.equal(await releaseReservation(id), expected);
      assert.equal(await commitReservation(id), expected, "too late to commit");
      assert.equal(await liveStock(), 10);
      assert.equal(await postgresStock(), 10);
    });

    it("never gives back stock an order owns", async () => {
      const id = await reserve(2);
      await commitReservation(id);
      assert.equal(await releaseReservation(id), "committed");
      assert.equal(await liveStock(), 8);
      assert.equal(await postgresStock(), 8);
    });

    it("lists only reservations that are still open", async () => {
      const open = await reserve();
      const done = await reserve();
      await commitReservation(done);
      const listed = (await staleReservations(0)).map((r) => r.reservationId);
      assert.deepEqual(listed, [open]);
      assert.deepEqual(await staleReservations(60_000), [], "nothing is a minute old yet");
    });

    it("lets exactly one of commit and release win when they race", async (t) => {
      await query("UPDATE products SET stock = 100 WHERE id = $1", [productId]);
      let committed = 0;
      for (let i = 0; i < 20; i++) {
        const id = await reserve();
        // Alternate which one starts first, and give it a 0-3 ms head start,
        // so the race explores both orders. (A single-statement commit
        // otherwise beats a release, which opens a transaction first.)
        const head = i % 4;
        const [commit, release] = i % 2 === 0
          ? await Promise.all([commitReservation(id), pause(head).then(() => releaseReservation(id))])
          : await Promise.all([pause(head).then(() => commitReservation(id)), releaseReservation(id)]);
        if (commit === "committed") {
          committed += 1;
          assert.ok(["committed", "committing"].includes(release), `release saw ${release}`);
        } else {
          assert.equal(release, "released");
        }
      }
      t.diagnostic(`${mode}: commit won ${committed} of 20 races, release won ${20 - committed}`);
      // Every winner accounted for, in both stores, with nothing left open.
      assert.equal(await postgresStock(), 100 - committed);
      assert.equal(await liveStock(), 100 - committed);
      assert.deepEqual(await staleReservations(0), []);
    });
  });
}

describe("redis mode, details", () => {
  beforeEach(() => {
    process.env.CHECKOUT_MODE = "redis";
  });

  it("finishes a commit that crashed halfway, and never releases it meanwhile", async () => {
    const id = await reserve(2);
    // The worker claimed the reservation, then died before writing Postgres.
    await claimRedisReservation(id);

    assert.equal(await releaseReservation(id), "committing", "the sweeper can't take it back");
    assert.deepEqual(
      (await staleReservations(0)).map((r) => [r.reservationId, r.state]),
      [[id, "committing"]]
    );

    // The retried job finishes the commit.
    assert.equal(await commitReservation(id), "committed");
    assert.equal(await postgresStock(), 8);
    assert.equal(await liveStock(), 8);
    assert.deepEqual(await staleReservations(0), []);
  });

  it("shows Postgres catching up with Redis as commits run", async () => {
    const product = () => ({ id: productId, stock: undefined });
    const id = await reserve(2);
    let view = await stockView({ ...product(), stock: await postgresStock() });
    assert.deepEqual(view, { live: 8, committed: 10, pending: 1 });

    await commitReservation(id);
    view = await stockView({ ...product(), stock: await postgresStock() });
    assert.deepEqual(view, { live: 8, committed: 8, pending: 0 });
  });
});
