import { readFileSync } from "node:fs";
import redis from "./redisClient.js";
import ApiError from "./ApiError.js";
import { getStocks } from "../models/Inventory.model.js";

// Redis mode: during a sale the live stock is a counter in Redis, and Lua
// scripts check and change it atomically. Postgres is updated when an order
// commits (see applyRedisCommit).
//
// A reservation is a hash, resv:<id> = { stock:<productId>: quantity, ..., state },
// and its id sits in the sorted set resv:pending, scored by when it was made:
//   reserved    stock held, no order claimed it yet   (reserve.lua)
//   committing  an order claimed it; never released    (claim.lua)
//   (gone)      committed to Postgres, or released     (forget / release.lua)

const lua = (file) => readFileSync(new URL(`../lua/${file}`, import.meta.url), "utf8");
redis.defineCommand("reserveStock", { lua: lua("reserve.lua") }); // key count passed per call
redis.defineCommand("releaseStock", { lua: lua("release.lua"), numberOfKeys: 2 });
redis.defineCommand("claimReservation", { lua: lua("claim.lua"), numberOfKeys: 1 });

const stockKey = (productId) => `stock:${productId}`;
const reservationKey = (reservationId) => `resv:${reservationId}`;
const PENDING = "resv:pending";
const UNTRACKED = "untracked"; // stored instead of a number when stock is NULL

// Copies stock from Postgres for products Redis doesn't have yet. SET NX
// never overwrites a live counter, so two requests loading the same product
// at once can't undo each other's reservations.
//
// Caveat: if a counter is deleted mid-sale (the old `flushall`!), it reloads
// from Postgres, which doesn't include reservations that haven't committed yet.
async function ensureLoaded(items) {
  const current = await redis.mget(items.map((item) => stockKey(item.productId)));
  const missing = items.filter((_, i) => current[i] === null).map((item) => item.productId);
  if (missing.length === 0) return;

  const stocks = await getStocks(missing);
  for (const productId of missing) {
    if (!stocks.has(productId)) throw new ApiError(404, `Product ${productId} not found`);
    const stock = stocks.get(productId);
    await redis.set(stockKey(productId), stock === null ? UNTRACKED : stock, "NX");
  }
}

export async function reserveRedis(reservationId, items) {
  await ensureLoaded(items);

  const keys = [reservationKey(reservationId), PENDING, ...items.map((item) => stockKey(item.productId))];
  const args = [reservationId, Date.now(), ...items.map((item) => item.quantity)];
  const failedAt = await redis.reserveStock(keys.length, ...keys, ...args);

  if (failedAt !== 0)
    throw new ApiError(409, `Not enough stock for product ${items[failedAt - 1].productId}`);
}

// 'released', 'gone' (nothing to release) or 'committing' (an order owns it).
export async function releaseRedis(reservationId) {
  const result = await redis.releaseStock(reservationKey(reservationId), PENDING, reservationId);
  if (result > 0) return "released";
  return result === -1 ? "committing" : "gone";
}

// Marks the reservation 'committing' and returns its items, or null if it's
// gone (already committed or released).
export async function claimRedisReservation(reservationId) {
  const flat = await redis.claimReservation(reservationKey(reservationId));
  if (flat.length === 0) return null;
  const items = [];
  for (let i = 0; i < flat.length; i += 2) {
    items.push({ productId: Number(flat[i].slice("stock:".length)), quantity: Number(flat[i + 1]) });
  }
  return items;
}

export async function forgetRedisReservation(reservationId) {
  await redis.multi().del(reservationKey(reservationId)).zrem(PENDING, reservationId).exec();
}

// Open reservations made more than `olderThanMs` ago, oldest first.
export async function staleRedisReservations(olderThanMs, limit) {
  const flat = await redis.zrangebyscore(PENDING, "-inf", Date.now() - olderThanMs, "WITHSCORES", "LIMIT", 0, limit);
  const stale = [];
  for (let i = 0; i < flat.length; i += 2) stale.push({ reservationId: flat[i], createdAt: Number(flat[i + 1]) });
  if (stale.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const { reservationId } of stale) pipeline.hget(reservationKey(reservationId), "state");
  const states = await pipeline.exec();
  return stale.map((reservation, i) => ({
    reservationId: reservation.reservationId,
    state: states[i][1] ?? "reserved", // created before states existed
    ageMs: Date.now() - reservation.createdAt,
  }));
}

// The live counter for a product: a number, null when it doesn't track
// stock, or undefined when Redis hasn't loaded it yet.
export async function redisStock(productId) {
  const value = await redis.get(stockKey(productId));
  if (value === null) return undefined;
  return value === UNTRACKED ? null : Number(value);
}

export const openRedisReservations = () => redis.zcard(PENDING);
