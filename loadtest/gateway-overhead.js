// What the rate limiter costs a request.
//
//   k6 run -e BASE_URL=http://localhost:5000 loadtest/gateway-overhead.js
//
// GET / is answered by the gateway itself, with no service behind it, so the
// difference between RATE_LIMIT_ALGORITHM=off and gcra is the limiter: one
// Redis round trip. Every request comes from a new client IP (X-Forwarded-For;
// start the gateway with TRUST_PROXY=loopback), so nothing is ever refused:
// this measures the price of saying yes.
//
// Two ways to run it:
//   as fast as possible (default): VUS users in a loop, shows max throughput
//   RATE=500: a steady 500 requests a second, shows the added latency
//             without the queueing that saturation adds
//
// Env vars: VUS (50), RATE (unset), DURATION (15s), BASE_URL (http://localhost:5000)

import http from "k6/http";

const BASE = __ENV.BASE_URL || "http://localhost:5000";
const DURATION = __ENV.DURATION || "15s";
const summaryTrendStats = ["med", "p(95)", "p(99)", "max"];

export const options = __ENV.RATE
  ? {
      scenarios: {
        steady: {
          executor: "constant-arrival-rate",
          rate: Number(__ENV.RATE),
          timeUnit: "1s",
          duration: DURATION,
          preAllocatedVUs: 50,
          maxVUs: 200,
        },
      },
      summaryTrendStats,
    }
  : { vus: Number(__ENV.VUS || 50), duration: DURATION, summaryTrendStats };

const octet = () => Math.floor(Math.random() * 256);

export default function () {
  http.get(`${BASE}/`, { headers: { "X-Forwarded-For": `10.${octet()}.${octet()}.${octet()}` } });
}
