import { ALGORITHMS } from "./ratelimit/limiter.js";

// Reads and checks the environment once at startup, so a typo fails loudly
// instead of quietly switching a protection off.
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 5000),
    services: {
      products: required(env, "PRODUCT_SERVICE_URL"),
      cart: required(env, "CART_SERVICE_URL"),
      orders: required(env, "ORDERS_SERVICE_URL"),
      search: required(env, "SEARCH_SERVICE_URL"),
    },
    rateLimit: {
      algorithm: oneOf(env, "RATE_LIMIT_ALGORITHM", ALGORITHMS, "gcra"),
      failMode: oneOf(env, "RATE_LIMIT_FAIL_MODE", ["open", "closed"], "open"),
    },
    redis: {
      host: env.REDIS_HOST || "localhost",
      port: Number(env.REDIS_PORT || 6379),
    },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

function required(env, name) {
  if (!env[name]) throw new Error(`${name} is not set`);
  return env[name];
}

function oneOf(env, name, allowed, fallback) {
  const value = (env[name] || fallback).trim();
  if (!allowed.includes(value))
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${value}"`);
  return value;
}

// Which proxies may tell the gateway a client's real IP through
// X-Forwarded-For. Anyone else could send that header with any IP they like
// and dodge the IP limits, so by default nobody is trusted.
//   (empty) / false   use the address of the connection itself
//   loopback, a CIDR, a list of them   trust those proxies only
//   a number          trust that many proxy hops
export function parseTrustProxy(raw = "") {
  const value = raw.trim();
  if (value === "" || value === "false") return false;
  if (value === "true")
    throw new Error(
      "TRUST_PROXY=true would believe any client's X-Forwarded-For. Name the proxies instead, e.g. loopback or 10.0.0.0/8"
    );
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
