# Ecommerce at Scale

A microservices store that I'm scaling up one real problem at a time,
measuring every change. Each step becomes a post in my LinkedIn series, using
only numbers from this repo.

**Stack:** Node 22 · Express 5 · PostgreSQL 17 · Redis 8 (Lua scripts, BullMQ) ·
RabbitMQ · Meilisearch · React 19 · k6 · Docker

## Project 1: Flash Sale Mode

What happens when hundreds of people try to buy the same ten pairs of
sneakers at once?

| Phase | The problem | What I built | Measured |
|---|---|---|---|
| 0 | Checkout never took stock away, and inventory needs multi-row transactions and row locks | Moved the store from MongoDB to Postgres, with plain SQL | Baseline: 20 orders placed on 10 units |
| 1 | 200 buyers for 10 pairs: the store sold 119 | Atomic stock reservations in four switchable modes: read-check-write, one conditional `UPDATE`, `SELECT … FOR UPDATE`, and a Redis Lua script | Read-check-write oversold by 81–109 units. Every correct mode sold exactly 10, every run |
| 2 | Bots took 84–88 of 100 units | A GCRA rate limiter in the gateway: per shopper and per IP, checked atomically in Lua, with IETF RateLimit headers. It keeps serving if Redis goes down | Bots got 15 of 100. Under a bot flood, humans' median wait fell from 323–338 ms to 73–74 ms. Cost: about 1.4 ms per request |
| 3 | A crash between "order saved" and "stock committed" | BullMQ job flows that are safe to retry, and a sweeper that repairs lost work | With the inventory worker down mid-sale, every order was confirmed within 1.8 s of its return. With Redis down, the sweeper recovered every order |
| 4 | A cold home page sends every shopper to Postgres at once, and clearing the cache wiped all of Redis, sale included | A versioned Redis cache with stampede protection that fails open, and RFC 9211 `Cache-Status` headers | 150 shoppers on a cold page: 150 Postgres queries became 1. Steady browsing: 97.9% hits, 98% fewer queries. With Redis down, the home page still answers in milliseconds |

Every number comes from runs recorded in
[the project 1 spec](docs/projects/01-flash-sale.md), including the ones
that didn't go my way: Redis hasn't yet beaten one conditional `UPDATE` on
raw speed. They're laptop numbers, so they compare approaches; they don't
measure production capacity.

## Architecture

```
React (Vite) ──▶ gateway :5000   CORS → shopper id check → GCRA rate limiter (Redis) → proxy
                   ├── products :5001  Postgres · stock reservations (4 modes) · Redis · RabbitMQ
                   ├── cart     :5002  Postgres · one cart per shopper
                   ├── orders   :5003  Postgres · reserve → save → queue a job flow · Bull Board
                   └── search   :5004  Meilisearch, fed from RabbitMQ

BullMQ: commit-stock (products worker) → confirm-order (orders worker)
        reconcile every 30 s: re-queues stuck orders, releases orphaned reservations
```

## Run it

You need Docker Desktop and Node 22.

```bash
npm run setup        # .env files and npm install everywhere
npm run dev          # containers, 5 services, 2 workers and the frontend
npm run sale -- 10   # in another terminal: a flash sale of 10 units
```

Then open http://localhost:5173/flash-sale. [docs/try-it.md](docs/try-it.md)
walks through it all from the browser, including stopping a worker and
taking Redis away.

## Tests

`npm test` runs 144 tests against real Postgres and Redis, in test databases
of their own:

| Suite | Tests | Covers |
|---|---|---|
| gateway | 69 | rate-limit math, atomicity, spoofed headers, Redis outages |
| products | 22 | every checkout mode, commit-versus-release races, a crash halfway through a commit |
| orders | 15 | confirming and cancelling orders, retries and overlapping runs, the sweeper |

Deliberately broken versions of the code were run against the suites to check
that each one fails.

## What's next

1. Search over 44,000 real products, with Elasticsearch.
2. A bulk catalog import on Supabase.
3. Production on GCP and Cloudflare, with Shopify webhooks.
4. An AI shopping assistant with LangSmith evals.

See [docs/pipeline.md](docs/pipeline.md).
