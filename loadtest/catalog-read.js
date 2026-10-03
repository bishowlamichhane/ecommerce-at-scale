// What the catalog cache buys, measured on the products service directly
// (the gateway in front of it costs the same in every mode).
//
//   k6 run -e SCENARIO=burst  loadtest/catalog-read.js
//   k6 run -e SCENARIO=browse loadtest/catalog-read.js
//
// Start products with CACHE_MODE=off, plain or protected to compare them.
//
// burst   BURST (150) shoppers open the home page at the same moment, right
//         after the catalog changed. Run `redis-cli INCR catalog:version`
//         first, so every cached entry is outdated. Without stampede
//         protection each of them reads Postgres; with it, one of them does.
// browse  a steady RATE (400) requests a second for DURATION (30s), shaped
//         like the storefront: everyone sees page 1, and each "load more" is
//         half as likely as the one before (10 pages of 20 at most). One
//         request in three looks up a single product from those pages, as
//         the cart and checkout do.
//
// The summary counts each response's Cache-Status header (RFC 9211), which
// is what the cache says it did. How many queries really reached Postgres
// comes from pg_stat_statements, not from this script: the header is the
// code under test describing itself.
//
// Product ids are taken as 1-200, the first 10 pages of a catalog numbered
// from 1 (as the seed is). A lookup that finds nothing is counted as
// item_not_found, so a catalog numbered differently shows in the summary.
//
// On Windows, keep BURST at 200 or below (see flash-sale.js).
//
// Env vars: SCENARIO (browse), BURST (150), RATE (400), DURATION (30s),
//           BASE_URL (http://localhost:5001)

import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:5001";
const SCENARIO = __ENV.SCENARIO || "browse";
const BURST = Number(__ENV.BURST || 150);
const RATE = Number(__ENV.RATE || 400);
const DURATION = __ENV.DURATION || "30s";
const PAGE_SIZE = 20;
const PAGES = 10;

const scenarios = {
  burst: { executor: "per-vu-iterations", vus: BURST, iterations: 1, maxDuration: "1m" },
  browse: {
    executor: "constant-arrival-rate",
    rate: RATE,
    timeUnit: "1s",
    duration: DURATION,
    preAllocatedVUs: 50,
    maxVUs: 200,
  },
};
if (!scenarios[SCENARIO]) throw new Error(`SCENARIO must be one of: ${Object.keys(scenarios).join(", ")}`);

export const options = {
  scenarios: { [SCENARIO]: scenarios[SCENARIO] },
  summaryTrendStats: ["med", "p(95)", "p(99)", "max"],
};

// What the cache says it did, one counter per outcome.
const outcomes = {
  hit: new Counter("cache_hit"), // answered from Redis
  miss: new Counter("cache_miss"), // read Postgres, then cached the result
  collapsed: new Counter("cache_collapsed"), // missed, and waited for another request's read
  bypass: new Counter("cache_bypass"), // skipped the cache: read Postgres
  none: new Counter("cache_status_missing"),
};
const failed = new Counter("failed_requests");
const notFound = new Counter("item_not_found");
const listDuration = new Trend("list_duration", true);
const itemDuration = new Trend("item_duration", true);

function outcome(header) {
  if (!header) return "none";
  if (/; hit\b/.test(header)) return "hit";
  if (header.includes("collapsed")) return "collapsed";
  if (header.includes("fwd=uri-miss")) return "miss";
  if (header.includes("fwd=bypass")) return "bypass";
  return "none";
}

function record(res, duration) {
  duration.add(res.timings.duration);
  outcomes[outcome(res.headers["Cache-Status"])].add(1);
  if (res.status === 404) notFound.add(1);
  else if (res.status !== 200) {
    failed.add(1);
    // VERBOSE=1 prints each unexpected answer; status 0 means no HTTP
    // response at all (connection refused, reset, timeout).
    if (__ENV.VERBOSE) console.log(`unexpected status=${res.status} error=${res.error} url=${res.url}`);
  }
}

// Page k (0-based) with probability 1/2^(k+1): everyone sees page 1, half of
// them load page 2, a quarter page 3, and so on.
function page() {
  let k = 0;
  while (k < PAGES - 1 && Math.random() < 0.5) k += 1;
  return k;
}

const list = (k) => http.get(`${BASE}/get-products?limit=${PAGE_SIZE}&skip=${k * PAGE_SIZE}`, { tags: { name: "list" } });

export default function () {
  if (SCENARIO === "burst") return record(list(0), listDuration);

  if (Math.random() < 2 / 3) return record(list(page()), listDuration);
  const id = page() * PAGE_SIZE + 1 + Math.floor(Math.random() * PAGE_SIZE);
  record(http.get(`${BASE}/get-product-by-id/${id}`, { tags: { name: "item" } }), itemDuration);
}
