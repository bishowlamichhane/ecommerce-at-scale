// Starts the whole store for local development, in one terminal: the
// containers, every service, both workers and the frontend, each log line
// prefixed by who wrote it. Ctrl+C stops everything.
//
//   npm run dev
//   npm run dev -- --without=inventory-worker   leave processes out (comma-separated),
//                                               e.g. to start that worker by hand
//                                               later: npm run worker:inventory

import { execSync } from "node:child_process";
import { concurrently } from "concurrently";

const PROCESSES = [
  { name: "gateway", command: "npm --prefix gateway run dev", prefixColor: "blue" },
  { name: "products", command: "npm --prefix services/products run dev", prefixColor: "green" },
  { name: "inventory-worker", command: "npm --prefix services/products run dev:worker", prefixColor: "greenBright" },
  { name: "cart", command: "npm --prefix services/cart run dev", prefixColor: "yellow" },
  { name: "orders", command: "npm --prefix services/orders run dev", prefixColor: "magenta" },
  { name: "orders-worker", command: "npm --prefix services/orders run dev:worker", prefixColor: "magentaBright" },
  { name: "search", command: "npm --prefix services/search run dev", prefixColor: "cyan" },
  { name: "web", command: "npm --prefix frontend run dev", prefixColor: "white" },
];

const without = new Set(
  process.argv
    .filter((arg) => arg.startsWith("--without="))
    .flatMap((arg) => arg.slice("--without=".length).split(","))
    .filter(Boolean)
);
const unknown = [...without].filter((name) => !PROCESSES.some((p) => p.name === name));
if (unknown.length > 0) {
  console.error(`Unknown process: ${unknown.join(", ")}. Choose from: ${PROCESSES.map((p) => p.name).join(", ")}`);
  process.exit(1);
}

// Postgres, Redis, RabbitMQ and Meilisearch first: the services need them at startup.
execSync("docker compose up -d --wait", { stdio: "inherit" });

if (without.size > 0) console.log(`Leaving out: ${[...without].join(", ")}`);
const { result } = concurrently(
  PROCESSES.filter((p) => !without.has(p.name)),
  { prefix: "name", killOthersOn: ["failure", "success"] }
);
result.catch(() => process.exit(1));
