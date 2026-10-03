// Flash-sale load test for k6.
//
//   k6 run -e BASE_URL=http://localhost:5000 -e PRODUCT_ID=1001 -e USERS=200 loadtest/flash-sale.js
//
// Or through Docker, with nothing to install:
//
//   docker run --rm -i -e PRODUCT_ID=1001 -e USERS=200 grafana/k6 run - < loadtest/flash-sale.js
//
// On Windows, prefer the native k6 binary (a single .exe from the k6 GitHub
// releases): under a burst, Docker's host.docker.internal hop timed out some
// connections. Keep USERS at 200 or below on a Windows laptop: beyond that the
// gateway's listen queue overflows and connections are refused before they
// reach the store (VERBOSE=1 shows them as status 0).
//
// Env vars:
//   PRODUCT_ID  the sale product (printed by `npm run sale:reset`)
//   USERS       concurrent buyers, each with its own X-User-Id (default 500)
//   BUYS        total purchase attempts, shared by the buyers (default USERS,
//               so every buyer tries once, all at the same moment)
//   FLOW        buy-now: one POST /orders/buy-now per attempt (default)
//               cart:    add to cart, then POST /orders/place-order
//   BASE_URL    the gateway (default http://host.docker.internal:5000)
//
// Units actually sold come from `npm run sale:report`, not from this script:
// counting 201s here would trust the very code under test.

import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://host.docker.internal:5000";
const PRODUCT_ID = Number(__ENV.PRODUCT_ID);
const USERS = Number(__ENV.USERS || 500);
const BUYS = Number(__ENV.BUYS || USERS);
const FLOW = __ENV.FLOW || "buy-now";

export const options = {
  scenarios: {
    sale: { executor: "shared-iterations", vus: USERS, iterations: BUYS, maxDuration: "3m" },
  },
  summaryTrendStats: ["med", "p(95)", "max"],
};

const created = new Counter("buy_201_created");
const soldOut = new Counter("buy_409_sold_out");
const limited = new Counter("buy_429_rate_limited");
const failed = new Counter("buy_other_status");
const buyDuration = new Trend("buy_duration", true);

export function setup() {
  if (!PRODUCT_ID) throw new Error("set PRODUCT_ID (see npm run sale:reset)");
}

export default function () {
  // Each buyer is its own client, with its own IP. The gateway only believes
  // X-Forwarded-For when started with TRUST_PROXY=loopback; without it, all
  // buyers share this machine's IP and the per-IP checkout limit applies.
  const params = {
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": `user-${__VU}`,
      "X-Forwarded-For": `10.${(__VU >> 16) & 255}.${(__VU >> 8) & 255}.${__VU & 255}`,
    },
  };
  const item = { productId: PRODUCT_ID, quantity: 1 };
  const address = { billing_address: "Kathmandu", shipping_address: "Kathmandu" };

  let res;
  if (FLOW === "cart") {
    http.post(`${BASE}/cart/add-to-cart`, JSON.stringify(item), params);
    res = http.post(`${BASE}/orders/place-order`, JSON.stringify(address), params);
  } else {
    res = http.post(`${BASE}/orders/buy-now`, JSON.stringify({ ...item, ...address }), params);
  }

  buyDuration.add(res.timings.duration);
  if (res.status === 201) created.add(1);
  else if (res.status === 409) soldOut.add(1);
  else if (res.status === 429) limited.add(1);
  else {
    failed.add(1);
    // VERBOSE=1 prints each unexpected answer; status 0 means no HTTP
    // response at all (connection refused, reset, timeout).
    if (__ENV.VERBOSE) console.log(`unexpected status=${res.status} error=${res.error} body=${String(res.body).slice(0, 120)}`);
  }
}
