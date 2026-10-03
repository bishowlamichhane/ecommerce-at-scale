# CLAUDE.md

Context for Claude Code sessions in this repo. Keep it current: when a project
ships or the architecture changes, update this file in the same change.

**Current focus: Project 1, Flash Sale Mode (Redis).** Done so far:
- phase 0: MongoDB → Postgres
- phase 1: atomic stock reservations
- phase 2: GCRA rate limiting in the gateway
- phase 3: background jobs with BullMQ, a self-healing sweeper and the sale page
- phase 4: the read path, a versioned catalog cache with stampede protection

Phase 5, the demo recording and the posts, is next; Bishow is doing it. The spec, checklist and every
measured result are in
[docs/projects/01-flash-sale.md](docs/projects/01-flash-sale.md). Read the spec
before working on any project task. [docs/try-it.md](docs/try-it.md) walks a
person through everything from the browser.

## What this repo is

A small microservices e-commerce store that Bishow Lamichhane is growing in
public for a LinkedIn series. Bishow is a Shopify App Developer at Cartmade.
The series shows the backend skills behind that job (Postgres, Redis,
Elasticsearch, Supabase, GCP, Cloudflare, LLMs) through mini-projects built on
this store. Each project fixes a real problem in the store and becomes two
posts: a design post while building, then a demo post with measured numbers.

This repo is a clean restart of Bishow's older private repo
(`D:/Internship/ecom-microservices`). That repo has the same original code
(on MongoDB), plus git history, `.env` files and `node_modules`. Treat it as an
archive and don't copy files from it.

## Ground rules

- **No employer IP.** Never open, copy or paraphrase code, data, client names
  or internal metrics from Bishow's work projects (the other folders under
  `D:/Internship`). Keep the domain fashion retail and use textbook patterns.
- **No secrets in git.** Real config lives in each service's `.env`
  (gitignored). When you add a variable, also add it to that folder's
  `.env.example` with a safe local default. Never put real credentials or
  hosted connection strings in code, compose files, docs or posts.
  Local-only defaults, like the compose Postgres user, are fine.
- **Real numbers only.** Any number that might appear in a post must come from
  a run in this repo. Record it in the project spec's *Results* section with
  the command, data size and machine. Never invent or round up results, and
  never tune a benchmark so the new approach wins. A laptop benchmark shows
  relative differences, not production capacity, and posts should say so.
- **Bishow must be able to explain every line in an interview.** Work in small,
  reviewable steps and explain why behind each design decision. Prefer plain
  code over clever abstractions. Ask before adding a dependency, tool or
  service. Each spec lists the ones already planned.
- **Git:** commit or push only when asked. Use one branch per project
  (`p1-flash-sale`, `p2-search`, …).

## Architecture

```
frontend (Vite + React 19, :5173): calls http://localhost:5000, sends X-User-Id
   │
gateway (:5000): CORS → X-User-Id check (400 if malformed) → GCRA rate limiter (Redis,
   │             rl:gcra:* keys) → http-proxy-middleware, which strips the prefix:
   │             /products  /cart  /orders  /search   (answers 404 for /products/inventory/*)
   │             (answers 404 for /orders/admin/* too)
   ├── products (:5001): Postgres product_service (products, reservations, sales)
   │      ├── /inventory/reserve|commit|release|stale: internal, for orders; CHECKOUT_MODE picks how
   │      ├── /sale/current: the sale page's data (product, live / committed / pending stock)
   │      ├── Redis: catalog cache catalog:list:{skip}:{limit} (60 s) and catalog:item:{id} (30 s),
   │      │          versioned by catalog:version (CACHE_MODE: off | plain | protected); in redis mode also
   │      │          stock:{id} counters, resv:{id} hashes (reserved → committing) and resv:pending
   │      └── RabbitMQ: publishes add/update/delete to queue product_updates
   ├── cart (:5002): Postgres cart_service, one cart per shopper; reads products through an opossum breaker
   ├── orders (:5003): Postgres orders_service (orders + reservation_id, order_items, notifications)
   │                   checkout and buy-now: reserve → save (Pending) → queue the job flow
   │                   /my-orders, /my-notifications; Bull Board at /admin/queues
   └── search (:5004): consumes product_updates → Meilisearch index "products"; no database

BullMQ (Redis), one flow per order:
  confirm-order (queue orders, orders worker)  ← runs after its child →
      commit-stock (queue inventory, products worker)
  reconcile (queue orders, every 30 s): re-queue stuck orders, release orphaned reservations
```

Every service has the same layout. `index.js` loads `.env`, connects to the
database, listens and connects to the broker. `app.js` builds the Express app.
Requests flow `routes/` → `controllers/` → `models/`. The models hold plain SQL
that runs through `pg`, with the pool in `db/db.js` and the tables in
`db/schema.sql`. `utils/` holds `ApiError`, `ApiResponse`, `asyncHandler`,
`circuitBreaker` and similar helpers.

Products and orders also have:
- `worker.js`: a BullMQ worker, run as its own process.
- `test/`: tests against `*_service_test` databases, which the tests create.

Two more files hold logic that matters:
- `services/products/utils/inventoryActions.js`: what the inventory can do in
  every checkout mode. Shared by the endpoints and the worker.
- `services/products/utils/cache.js`: the read-through cache (versioned
  entries, stampede protection, fail-open), with its catalog settings in
  `catalogCache.js`.
- `services/orders/jobs/`: the job processors (`confirmOrder.js`,
  `reconcile.js`).

The gateway is laid out differently:
- `index.js` reads the env through `config.js`, which fails fast on bad
  values.
- `app.js` builds the app, so tests can start it.
- `redisClient.js` holds the fail-fast Redis client.
- `ratelimit/` holds the Lua scripts, `policies.js` (every limit and its
  reason), `limiter.js`, `middleware.js`, `headers.js` and `identity.js`.
- `test/` holds the tests.

## Running locally

From the repo root:

```bash
npm run setup          # once: .env files from .env.example (never overwritten), npm install everywhere
npm run dev            # containers + 5 services + 2 workers + frontend (:5173), one terminal, Ctrl+C stops all
npm run dev -- --without=inventory-worker      # leave processes out (e.g. for the worker drill)
npm run worker:inventory / worker:orders       # start a worker on its own
npm run seed           # 1,000 generated products (with the stack running)
npm run sale -- 10     # a flash sale of 10 units; resets its orders, carts and rate limits
npm run sale:report    # units sold, orders by status, open reservations
npm test               # all 144 tests (needs the containers)
```

Under the hood, `scripts/dev.mjs` runs each package's own `npm run dev`
(nodemon) or `dev:worker` through concurrently.

To run the flash-sale load tests (details in the project 1 spec):

```bash
npm run sale -- 10                                   # prints PRODUCT_ID
k6 run -e BASE_URL=http://localhost:5000 -e PRODUCT_ID=<id> -e USERS=200 loadtest/flash-sale.js
npm run sale:report
cd services/products && npm run sale:drain           # waits until no order is Pending
```

To switch modes, set `CHECKOUT_MODE` in `services/products/.env` and restart
products. On this Windows laptop, keep k6 at 200 or fewer simultaneous
buyers and run it natively, not in Docker; the spec explains why.

Load tests simulate many clients from one machine. So start the gateway with
`TRUST_PROXY=loopback`, which makes it believe the X-Forwarded-For each k6
client sends. Otherwise every buyer shares one IP and the per-IP checkout limit
refuses them. `RATE_LIMIT_ALGORITHM=off` reproduces the phase 1 numbers.
`npm run sale:reset` also clears the rate-limit state. The rate-limit load
tests are `loadtest/bots-vs-humans.js` and `loadtest/gateway-overhead.js`.

The test suites (`npm test` runs all three) need the containers running:

| Suite | Tests | Uses |
|---|---|---|
| gateway | 69 | Redis database 15, wiped by the tests |
| products | 22 | `product_service_test` and Redis database 14 |
| orders | 15 | `orders_service_test` |

They never touch the dev data.

Start the containers before the services; `npm run dev` does that. products
crashes if RabbitMQ is down, because `connectRabbitMQ()` is neither awaited
nor retried. search never retries its consumer. Frontend lint is
`npm run lint`. The `keyword` error in `Header.jsx` predates this work; project
2 rewrites that search box.

Postgres listens on host port **5433**, so it doesn't clash with another local
Postgres on 5432. `docker/postgres/init.sql` creates the databases only when
the volume is first created. `docker compose down -v` deletes every volume,
data included.

## Conventions and gotchas

- ESM everywhere, Express 5, `pg` with plain parameterized SQL, and no ORM.
  Node 22 runs locally. The Dockerfiles are dev-only (`node:18`, nodemon), and
  the gateway and search ones are commented out.
- `db/schema.sql` runs on every boot, so it may only contain idempotent
  statements. Change an existing table with `ALTER … ADD COLUMN IF NOT EXISTS`
  plus an index `IF NOT EXISTS`; see the cart's `user_id`.
- `db/db.js` parses `numeric` to JS numbers. Models drop `null` columns from
  the JSON, as Mongo used to omit unset fields; other services rely on a
  missing `stock`.
- `stock IS NULL` means the product doesn't track stock and can always be
  bought. The seed data has no stock.
- The shopper is the `X-User-Id` header, or `guest` if it's missing. There's no
  auth yet. Carts and orders are keyed by it. The gateway refuses malformed ids
  with a 400 (1–64 of `[A-Za-z0-9._:@-]`). Because any client can make one up,
  the shopper id is never the only rate limit: every policy also limits by IP.
- Rate limits live in `gateway/ratelimit/policies.js`. A change to a number
  needs its reason next to it, and the gateway tests must still pass. Keep
  the limiter atomic: one script call per request, checking all of the
  request's limits.
- Only believe `X-Forwarded-For` through `TRUST_PROXY`, naming the proxy (for
  example loopback for load tests, or a CDN's ranges in production). Never
  set it to `true`; `config.js` refuses that.
- Controllers call `new ApiResponse(status, "text", payload)`, but the
  constructor's signature is `(statusCode, data, message)`. So the payload
  lands in `.message`, and the frontend reads `res.data.message`. Don't fix
  this in passing: changing it breaks every client call.
- To return an error, throw `new ApiError(status, msg)` inside `asyncHandler`.
  It replies `{ message, success: false }`.
- `utils/circuitBreaker.js` is copy-pasted into each service. Each process has
  one opossum breaker, shared by every downstream URL. Orders' calls to
  `/inventory/*` deliberately bypass it, because 409 "sold out" answers would
  open it.
- In the services, RabbitMQ and Meilisearch hosts are hardcoded to
  `localhost` in both `messageQueue.js`, `meiliClient.js` and the `/sync` URL
  in `search.controller.js`. That works on the host. Moving them to env vars
  is part of project 4. Every Redis client already reads `REDIS_HOST` and
  `REDIS_PORT`.
- **The catalog cache.** Every write to products calls
  `catalogCache().invalidate()` (one `INCR catalog:version`) after the
  database write and before publishing, because publishing can throw. Never
  scan with `KEYS` or clear Redis with `flushall`/`flushdb` in app code: Redis
  also holds the rate limits, sale counters, reservations and job queues.
  Stock in cached products can be 30 s old; the reservation is the real stock
  check. Responses say what the cache did in a `Cache-Status` header
  (RFC 9211). Redis clients in the services fail fast (no offline queue);
  copy `services/products/utils/redisClient.js`.
- Never delete `stock:*` keys during a redis-mode sale. They reload from
  Postgres, which doesn't include reservations that haven't committed yet.
- **Background jobs** (BullMQ 6). Every job must be safe to run twice:
  workers crash, jobs retry, and a timed-out command can still execute.
  Ways to get there:
  - Use deterministic job ids as idempotency keys: `commit-<reservationId>`,
    `confirm-<orderId>`. BullMQ ids can't contain `:`.
  - Change state with a conditional UPDATE (`WHERE status = 'Pending'`), not
    read-check-write.
  - Make side effects unique (notifications: `UNIQUE (order_id, kind)`).
- **Job outcomes.** Job processors return outcomes and throw only to retry;
  use `UnrecoverableError` when retrying can't help. Producers fail fast (no
  offline queue, 1 s timeout), and the sweeper (`jobs/reconcile.js`) catches
  whatever couldn't be queued. Workers need `maxRetriesPerRequest: null`.
- **Changing the flow.** A new step in an order's life needs three things:
  a case in `reconcile.js` for when it gets stuck, a test in
  `services/orders/test/jobs.test.js`, and its status in the sale page's
  `STATUS` map.
- **Job processors live in `services/orders/jobs/`.** Inventory logic lives in
  `services/products/utils/inventoryActions.js`, shared by the HTTP endpoints
  and the worker; keep it the single place where checkout modes differ.
- Don't add `express.json()` to the gateway. It would consume request bodies
  before the proxy forwards them.

## Known bugs: each belongs to a project

Fix a bug inside the project that owns it, not in passing. The before/after is
post material.

| Bug | Where | Project |
|---|---|---|
| The search consumer indexes only name, price, stock, category and description, so search results lack image, colour and gender | `search/utils/messageQueue.js` | 2 |
| The subcategory filter never applies: the frontend sends `subcategory`, the backend reads `subCategory` | `Categories.jsx`, `product.controller.js` | 2 |
| Search fires on every keystroke with no debounce or cancel, so stale results can win | `Header.jsx` | 2 |
| Dual write: the product is saved, then publishing throws if RabbitMQ is down, so it's never indexed | `product.controller.js` `addProduct` | 4 |
| The consumer acks failed messages, and published messages aren't persistent | both `utils/messageQueue.js` | 4 |
| Cart's breaker fallback crashes because the fallback object has no `.message` | `cart.controller.js` `getCartItems` | 4 |
| The shared opossum breaker counts 4xx answers (404, 409) as failures | `utils/circuitBreaker.js` | 4 |

## The series

| # | Project | Status | Spec |
|---|---|---|---|
| 1 | Flash Sale Mode (Redis) | **active**, phase 5 (demo and posts) next | [01-flash-sale.md](docs/projects/01-flash-sale.md) |
| 2 | Search 44k real products (Elasticsearch) | pipeline | [pipeline.md](docs/pipeline.md) |
| 3 | Bulk catalog import (Supabase) | pipeline | [pipeline.md](docs/pipeline.md) |
| 4 | Go to production (GCP, Cloudflare, Shopify webhooks) | pipeline | [pipeline.md](docs/pipeline.md) |
| 5 | AI shopping assistant (LLM + LangSmith) | pipeline | [pipeline.md](docs/pipeline.md) |

Tick the active spec's checklist as items land. When a project ships:

1. Fill in its Results and post links, and mark it done here.
2. Move the next project from `docs/pipeline.md` into `docs/projects/0N-<slug>.md`.
3. Update *Current focus* at the top of this file.

## Writing the LinkedIn posts

Drafts go in `posts/NN-<slug>.md`. Write in Bishow's voice: first person,
plain English, short paragraphs, a few emoji as section markers (✅ 📍 💡),
no hype. Open with the problem, show the architecture or the numbers, and end
with one takeaway and a question. Architecture explainers with a diagram and a
short code snippet have worked before. Posts that only named a tool did poorly.
Put the repo link in the first comment, not in the post.
