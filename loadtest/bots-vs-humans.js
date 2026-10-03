// Bots vs humans in a flash sale: who gets the stock, and how fast do
// humans get an answer while bots hammer checkout?
//
//   k6 run -e BASE_URL=http://localhost:5000 -e PRODUCT_ID=1001 loadtest/bots-vs-humans.js
//
// Start the gateway with TRUST_PROXY=loopback: every simulated client sends
// its own X-Forwarded-For, the way a CDN in front would.
//
// Env vars:
//   PRODUCT_ID   the sale product (printed by `npm run sale:reset`)
//   HUMANS       people; each buys once at a random moment in the first SPREAD seconds (150)
//   SPREAD       seconds over which humans arrive (10)
//   BOTS         bot operators, one IP each (5)
//   TASKS        parallel tasks per bot, each buying as fast as it can (10)
//   BOT_SECONDS  how long the bots keep going (10)
//   BOT_IDS      fixed:    one X-User-Id per bot
//                rotating: a new X-User-Id on every request, to dodge per-user limits
//   BASE_URL     the gateway (default http://localhost:5000)
//
// Units sold to each side come from `npm run sale:report` (soldTo), which
// counts order rows: X-User-Ids starting with "bot-" are bots.

import http from "k6/http";
import exec from "k6/execution";
import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:5000";
const PRODUCT_ID = Number(__ENV.PRODUCT_ID);
const HUMANS = Number(__ENV.HUMANS || 150);
const SPREAD = Number(__ENV.SPREAD || 10);
const BOTS = Number(__ENV.BOTS || 5);
const TASKS = Number(__ENV.TASKS || 10);
const BOT_SECONDS = Number(__ENV.BOT_SECONDS || 10);
const BOT_IDS = __ENV.BOT_IDS || "fixed";

export const options = {
  scenarios: {
    humans: { executor: "per-vu-iterations", vus: HUMANS, iterations: 1, maxDuration: "2m", exec: "human" },
    bots: { executor: "constant-vus", vus: BOTS * TASKS, duration: `${BOT_SECONDS}s`, exec: "bot" },
  },
  summaryTrendStats: ["med", "p(95)", "max"],
};

const metricsFor = (side) => ({
  created: new Counter(`${side}_201_created`),
  soldOut: new Counter(`${side}_409_sold_out`),
  limited: new Counter(`${side}_429_rate_limited`),
  other: new Counter(`${side}_other_status`),
  duration: new Trend(`${side}_duration`, true),
});
const humanMetrics = metricsFor("human");
const botMetrics = metricsFor("bot");

export function setup() {
  if (!PRODUCT_ID) throw new Error("set PRODUCT_ID (see npm run sale:reset)");
  if (!["fixed", "rotating"].includes(BOT_IDS)) throw new Error("BOT_IDS must be fixed or rotating");
}

function buy(metrics, userId, ip) {
  const res = http.post(
    `${BASE}/orders/buy-now`,
    JSON.stringify({ productId: PRODUCT_ID, quantity: 1, billing_address: "Kathmandu", shipping_address: "Kathmandu" }),
    { headers: { "Content-Type": "application/json", "X-User-Id": userId, "X-Forwarded-For": ip } }
  );
  metrics.duration.add(res.timings.duration);
  if (res.status === 201) metrics.created.add(1);
  else if (res.status === 409) metrics.soldOut.add(1);
  else if (res.status === 429) metrics.limited.add(1);
  else metrics.other.add(1);
}

export function human() {
  const n = exec.vu.idInTest;
  sleep(Math.random() * SPREAD);
  buy(humanMetrics, `user-${n}`, `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
}

export function bot() {
  const operator = exec.vu.idInTest % BOTS;
  const userId = BOT_IDS === "rotating"
    ? `bot-${operator}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`
    : `bot-${operator}`;
  buy(botMetrics, userId, `203.0.113.${operator + 1}`);
}
