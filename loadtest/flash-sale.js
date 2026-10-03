// Flash-sale load test for k6. Runs through Docker, so nothing to install:
//
//   docker run --rm -i -e PRODUCT_ID=1001 -e USERS=500 grafana/k6 run - < loadtest/flash-sale.js
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
  const params = {
    headers: { "Content-Type": "application/json", "X-User-Id": `user-${__VU}` },
  };
  const item = JSON.stringify({ productId: PRODUCT_ID, quantity: 1 });

  let res;
  if (FLOW === "cart") {
    http.post(`${BASE}/cart/add-to-cart`, item, params);
    res = http.post(
      `${BASE}/orders/place-order`,
      JSON.stringify({ billing_address: "Kathmandu", shipping_address: "Kathmandu" }),
      params
    );
  } else {
    res = http.post(`${BASE}/orders/buy-now`, item, params);
  }

  buyDuration.add(res.timings.duration);
  if (res.status === 201) created.add(1);
  else if (res.status === 409) soldOut.add(1);
  else if (res.status === 429) limited.add(1);
  else failed.add(1);
}
