import { cacheRedis } from "./redisClient.js";
import { createCache } from "./cache.js";

// The products service's cache: pages of the product list and single
// products, both read from Postgres. Created on first use, so CACHE_MODE is
// read after .env is loaded.
let cache;
export const catalogCache = () =>
  (cache ??= createCache({ redis: cacheRedis, name: "catalog", mode: process.env.CACHE_MODE || "protected" }));

// How long a cached entry may be served without an invalidation.
export const LIST_TTL_SECONDS = 60;
// Product data includes `stock`, which changes on every purchase without
// invalidating the cache: cached stock can be up to this many seconds old.
// That's fine for display and the cart's quick check. What a buyer can
// actually buy is decided by the reservation at checkout, never by the cache.
export const ITEM_TTL_SECONDS = 30;

export const listKey = (skip, limit) => `list:${skip}:${limit}`;
export const itemKey = (id) => `item:${id}`;
