import { readFileSync } from "node:fs";
import redis from "./redisClient.js";
import ApiError from "./ApiError.js";
import { getStocks } from "../models/Inventory.model.js";

// Redis mode: during a sale the live stock is a counter in Redis, and Lua
// scripts check and change it atomically. Postgres is updated when an order
// commits (see applyRedisCommit).

const lua = (file) => readFileSync(new URL(`../lua/${file}`, import.meta.url), "utf8");
redis.defineCommand("reserveStock", { lua: lua("reserve.lua") }); // key count passed per call
redis.defineCommand("releaseStock", { lua: lua("release.lua"), numberOfKeys: 2 });

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

export async function releaseRedis(reservationId) {
  const released = await redis.releaseStock(reservationKey(reservationId), PENDING, reservationId);
  return released > 0;
}

// The items of an open reservation, or null once it's committed or released.
export async function getRedisReservation(reservationId) {
  const taken = await redis.hgetall(reservationKey(reservationId));
  const entries = Object.entries(taken);
  if (entries.length === 0) return null;
  return entries.map(([key, quantity]) => ({
    productId: Number(key.slice("stock:".length)),
    quantity: Number(quantity),
  }));
}

export async function forgetRedisReservation(reservationId) {
  await redis.multi().del(reservationKey(reservationId)).zrem(PENDING, reservationId).exec();
}
