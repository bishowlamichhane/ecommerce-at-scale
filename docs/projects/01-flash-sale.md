# Project 1: Flash Sale Mode (Redis)

- **Status:** active. Phases 0 and 1 are done; phase 2 (rate limiting) is next.
- **Branch:** `p1-flash-sale`
- **Estimate:** about 2 weeks part-time including the move to Postgres (about
  1.5 weeks for the "must" phases)
- **Shows:** Postgres transactions and row locks, Redis beyond caching (Lua for
  atomicity, TTLs, sorted sets), rate limiting, BullMQ job queues, cache
  invalidation done right, concurrency bugs, load testing with k6.

## The story

> "200 people tried to buy the last 10 pairs of sneakers in the same second. My store sold 119 of them."

That's the naive version, measured (see Results). A flash sale is when a
store's backend gets tested: one hot product, a few units, hundreds of buyers
at once. Before this project the store failed that test:

1. **Stock never went down.** `placeOrder` PATCHed the new stock to
   `/update-product`, but `updateProduct` only set `image`. *(Fixed in phase 1.)*
2. **Read-check-write is a race.** Even with the write fixed, two requests can
   both read `stock: 1`, both pass the check and both write `0`. Two units get
   sold. *(Phase 1: naive mode keeps this on purpose so it can be measured.)*
3. **Every shopper shared one cart**, and orders ignored the user. *(Fixed in phase 1.)*
4. **There's no rate limiting.** One script can hammer checkout. *(Phase 2.)*
5. **Cache invalidation blocks Redis** (`KEYS products:*`). `removeAllProducts`
   also runs `flushall`, which would now also wipe the sale's stock counters
   and reservations. *(Phase 4.)*

The honest arc for the posts: the *minimal* correct fix is one conditional
`UPDATE` in Postgres. Redis has to earn its place with measured results. So
far it hasn't, under sustained load (see Results).

## Design

### Phase 0: MongoDB → Postgres (done)

Inventory is a transactions-and-locking problem, and Postgres is the database
behind Bishow's day-to-day stack (Supabase).

- **Plain SQL:** products, cart and orders use `pg` with plain, parameterized
  SQL, with no ORM, so every query stays visible in the code and in the posts.
- **Schema:** each service has its own database, created by
  `docker/postgres/init.sql`. Each service runs its own `db/schema.sql` on
  boot, and every statement in it is idempotent.
- **Tables:** they mirror the old Mongoose models:
  - `products`
  - `carts` and `cart_items`
  - `orders` and `order_items`
- **Money:** prices are `numeric(10,2)`, parsed to JS numbers in `db/db.js`.
  Null columns are dropped from JSON, the way Mongo omitted unset fields.
- **Stock:** `products.stock` has `CHECK (stock >= 0)`, and `stock IS NULL`
  means the product doesn't track stock. The seed data has none.
- **Ids:** they're numbers called `id` everywhere, frontend included.
- **Behaviour:** it stayed identical, known bugs included, so each fix has a
  before/after.
- **Search client:** `meilisearch` moved to 0.62.0, because the locked 1.16.0
  isn't on npm.

### How an order takes stock (phase 1)

The orders service owns the flow. Products owns the stock.

1. Orders generates a reservation id (a UUID) and calls
   `POST /inventory/reserve { reservationId, items: [{ productId, quantity }] }`.
   The answer is 200, or 409 if anything is sold out, or 404. It's all items
   or none.
2. Orders writes the order (with its items, in one transaction).
3. **On success:** orders calls `POST /inventory/commit`.
   **On failure:** it calls `POST /inventory/release`, which puts the stock back.
   Both calls are safe to repeat.
4. A failed commit is logged rather than failing the order. Phase 3 makes it a
   job that retries.

More rules:

- `/inventory/*` is internal. The gateway answers 404 for
  `/products/inventory/*`.
- These calls skip the opossum breaker. Hundreds of 409 "sold out" answers in a
  few seconds would count as failures and open it.
- Items are merged by product and sorted by id before anything is locked.
  Every order takes row locks in the same sequence, so two orders can't
  deadlock each other.
- **Shopper identity:** the `X-User-Id` header, defaulting to `guest`. The
  frontend sends a random id kept in localStorage; k6 sends `user-<VU>`. Carts
  are one row per `user_id`, and orders store it.

### Checkout modes

`CHECKOUT_MODE` in `services/products/.env` picks the reserve implementation.
Orders and the load test don't change between modes.

| Mode | How stock is taken | Result (Results below) |
|---|---|---|
| `naive` | `SELECT stock`, check in code, `UPDATE … SET stock = <computed>`, all inside a transaction | oversells: READ COMMITTED doesn't stop the lost update |
| `postgres` | `UPDATE products SET stock = stock - $2 WHERE id = $1 AND (stock IS NULL OR stock >= $2)` | correct; buyers queue on the row lock and re-check against the newest row |
| `postgres-lock` | `SELECT … FOR UPDATE`, check, then `UPDATE` | correct; holds the lock while checking, even for sold-out answers |
| `redis` | `reserve.lua` checks and decrements `stock:<id>` counters atomically | correct; sold-out answers never touch Postgres |

How the redis mode works:

- **Loading stock:** the first reserve for a product copies its stock into
  `stock:<id>` with `SET NX`, so a live counter is never overwritten.
  Untracked products store `untracked`.
- **`reserve.lua`:** it's all-or-nothing across items. It records
  `resv:<id>` (stock key → quantity) and adds the id to the sorted set
  `resv:pending`.
- **`release.lua`:** it returns the units and removes both keys. Releasing
  something that's gone returns 0.
- **Commit:** Postgres catches up here. The reservation id goes into
  `reservations` with `ON CONFLICT DO NOTHING`, so a repeated commit changes
  nothing. Then the stock is decremented with no check, because Redis already
  decided; if Postgres had drifted, `CHECK (stock >= 0)` rolls it back.
- **Caveat:** if a `stock:<id>` key is deleted mid-sale, it reloads from
  Postgres, which doesn't include reservations that haven't committed yet.
  Never flush Redis during a sale.
- **Persistence:** Redis runs with AOF on. BullMQ needs
  `maxmemory-policy noeviction`, so if memory is ever capped for the cache, the
  queues get their own Redis.

### Still to build

- **Rate limiter in the gateway (phase 2):** a sliding window in a Redis sorted
  set on `/orders/*`. It's keyed by `X-User-Id`, falling back to IP, because
  all k6 traffic comes from one IP. It replies 429 with `Retry-After` and
  `X-RateLimit-*` headers.
- **BullMQ (phase 3):** `commit-stock`, `send-confirmation` (a simulated email)
  and a repeatable `release-expired`. The last one sweeps `resv:pending` and
  `status = 'reserved'` rows older than N minutes; today nothing releases a
  reservation whose order never committed or released, for example after a
  crash. Jobs retry with exponential backoff, and Bull Board at `/admin/queues`
  shows them.
- **Cache fixes (phase 4):**
  - versioned listing keys instead of `KEYS`
  - no `flushall`
  - lock-based stampede protection
  - a product-detail cache
- **Demo page** `/flash-sale` (phase 5).

### Dependencies

- Added: `pg` in products, cart and orders (it replaced `mongoose`).
- Planned: `ioredis` in the gateway (phase 2), plus `bullmq`,
  `@bull-board/api` and `@bull-board/express` in products (phase 3).
- k6: the native binary, or the `grafana/k6` Docker image (see Results for why
  native).

## Checklist

### Phase 0: Postgres, harness and baseline (must)
- [x] Postgres in `docker-compose.yml` (host port 5433), one database per service
- [x] Port products, cart and orders from Mongoose to `pg`, behaviour unchanged
- [x] Switch ids from `_id` to `id` in the services, the search consumer and the frontend
- [x] Drop search's unused Mongo connection; remove Mongo from compose and `MONGODB_URI` from the env files
- [x] Smoke test through the gateway:
  - seed 1,000 products
  - search and filter
  - add to, merge in and remove from the cart
  - checkout and order status
  - resync search
  - frontend build
- [x] Harness: `npm run sale:reset -- <stock>` / `npm run sale:report` (`services/products/scripts/flash-sale.js`)
- [x] `loadtest/flash-sale.js` (k6): FLOW=buy-now or cart; counts 201/409/429/other plus latency
- [x] Baseline run → Results

### Phase 1: correct under concurrency (must)
- [x] `POST /orders/buy-now`, plus `/inventory/reserve`, `/commit` and `/release` in products
- [x] `naive` mode (stock write fixed)
- [x] `postgres` mode
- [x] `postgres-lock` mode (was "could")
- [x] `redis` mode: lazy-loaded counters, `reserve.lua`, `release.lua`, idempotent commit to Postgres
- [x] Orders store the user
- [x] Per-user carts: decided on a `user_id` column on the Postgres cart; cart checkout uses the same reserve path
- [x] Gateway refuses `/products/inventory/*`
- [x] 34 correctness checks pass in every mode:
  - reserve/release/commit, with repeats harmless
  - all-or-nothing, untracked, unknown and duplicate items
  - buy-now, per-shopper carts, recorded users
- [x] Load-test all modes → Results

### Phase 2: rate limiting (must)
- [ ] Sliding-window limiter in the gateway, with 429 and headers
- [ ] Test: one abusive user gets limited, and normal users don't notice

### Phase 3: async work (should)
- [ ] BullMQ queue and worker for `commit-stock`, `send-confirmation` and `release-expired`
- [ ] Bull Board for the demo
- [ ] Kill the worker mid-sale, restart it, and show that nothing is lost
- [ ] Re-run the sustained test: does redis pull ahead once the commit is off the request path?

### Phase 4: read path (should)
- [ ] Versioned cache keys; remove `KEYS` and `flushall`
- [ ] Stampede protection and the product-detail cache
- [ ] k6 read test: p95 and hit ratio (`INFO stats`) with the cache on vs off → Results

### Phase 5: demo and posts (must)
- [ ] `/flash-sale` page with live stock
- [ ] Record the split-screen demo (naive vs redis)
- [ ] Drafts of post A (design) and post B (demo) in `posts/`

## Results

Only numbers from this section go into posts.

**Setup:**
- **Machine:** AMD Ryzen 5 7535HS (6 cores, 12 threads), 15.2 GB RAM,
  Windows 11, Docker Desktop 29.5, Node 22.22.
- **Infrastructure:** Postgres 17, Redis 8 and RabbitMQ in Docker, with the
  Node services on the host.
- **k6:** 2.3.0.
- **Timing:** latency is the purchase request only (`buy_duration`), measured
  by k6 through the gateway.
- **"Sold":** units on order rows, counted by `npm run sale:report`.

Every run below ended with zero open reservations.

### Phase 0 baseline: original code, cart then checkout

| Date | Stock | Buyers | Attempts | Orders | Oversold | Median | p95 | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-10-03 | 10 | 1 | 20 | 20 | **10** | 63.7 ms | 88.4 ms | Docker k6, one at a time (the shared cart would muddle concurrency). Stock still showed 10 afterwards |

### Burst: 200 buyers at once, 10 units, buy-now (native k6)

| Date | Mode | Orders | Oversold | 409 | Other | Median | p95 |
|---|---|---|---|---|---|---|---|
| 2026-10-03 | naive | 91 | **81** | 109 | 0 | 1.18 s | 1.27 s |
| 2026-10-03 | naive | 107 | **97** | 93 | 0 | 1.19 s | 1.38 s |
| 2026-10-03 | naive | 119 | **109** | 81 | 0 | 1.27 s | 1.40 s |
| 2026-10-03 | postgres | 10 | 0 | 190 | 0 | 1.02 s | 1.21 s |
| 2026-10-03 | postgres | 10 | 0 | 190 | 0 | 1.13 s | 1.29 s |
| 2026-10-03 | postgres | 10 | 0 | 190 | 0 | 1.40 s | 1.62 s |
| 2026-10-03 | postgres-lock | 10 | 0 | 190 | 0 | 948 ms | 1.05 s |
| 2026-10-03 | postgres-lock | 10 | 0 | 190 | 0 | 970 ms | 1.10 s |
| 2026-10-03 | postgres-lock | 10 | 0 | 190 | 0 | 860 ms | 1.02 s |
| 2026-10-03 | redis | 10 | 0 | 190 | 0 | 783 ms | 924 ms |
| 2026-10-03 | redis | 10 | 0 | 190 | 0 | 831 ms | 933 ms |
| 2026-10-03 | redis | 10 | 0 | 190 | 0 | 860 ms | 983 ms |

### Sustained: 200 buyers, 2,000 attempts (10 each), 1,000 units, buy-now (one run each)

| Date | Mode | Orders | Oversold | Attempts/s | Median | p95 |
|---|---|---|---|---|---|---|
| 2026-10-03 | naive | 2,000 | **1,000** | 158 | 1.19 s | 1.66 s |
| 2026-10-03 | postgres | 1,000 | 0 | 197 | 904 ms | 1.51 s |
| 2026-10-03 | postgres-lock | 1,000 | 0 | 172 | 1.10 s | 1.87 s |
| 2026-10-03 | redis | 1,000 | 0 | 190 | 1.06 s | 1.79 s |

### Cart checkout: 200 shoppers, each adds 1 and checks out, 10 units

| Date | Mode | Orders | Oversold | 409 | Median (checkout) | p95 |
|---|---|---|---|---|---|---|
| 2026-10-03 | postgres | 10 | 0 | 190 | 1.38 s | 1.59 s |
| 2026-10-03 | redis | 10 | 0 | 190 | 962 ms | 1.31 s |

### What the numbers say

1. **Naive oversold in every run**, even though its read and write share a
   transaction: 81–109 extra units at 200 buyers. Under sustained load it sold
   all 2,000 attempts against 1,000 units, because lost updates kept the
   counter from ever reaching zero.
2. **Every correct mode sold exactly the stock, every run**, with no
   reservations left open.
3. **Burst, where most answers are "sold out":** redis was quickest (median
   783–860 ms), then postgres-lock (860–970 ms), then postgres
   (1.02–1.40 s). But identical postgres runs moved by about 0.4 s, and most
   of a request is HTTP hops: gateway → orders → products for the product,
   then the reserve, then the commit. So rank them loosely.
4. **Sustained, where half succeed:** plain `postgres` was fastest (197
   attempts/s); redis did 190 and postgres-lock 172. Redis's synchronous
   commit to Postgres gives back what the Lua check saves. Phase 3 moves the
   commit to a job, and then we re-measure. For now the honest headline is
   that "one conditional UPDATE is enough at this scale".

### Harness limits found

- **500 buyers at once:**
  - **With native k6:** 222–232 of the 500 connections were refused
    (status 0). Windows' listen queue on the gateway overflowed, so those
    requests never reached the app.
  - **With Docker k6:** the `host.docker.internal` hop also timed out
    connections. 27 of 150 failed in one run.
- **The decision:** native k6 at 200 buyers. Every request got an HTTP answer
  in every run above.
- **Excluded runs:** the early 500-buyer Docker runs (naive oversold 111–162,
  postgres 0, but 31–153 connection failures each) aren't in the tables. The
  correctness verdict was the same.

## Posts

- **Optional, early:** why the store moved from MongoDB to Postgres before the
  flash sale. The reason is fit for this workload (multi-row transactions,
  row locks), not "Mongo bad".
- **A, design:** draw the race (two requests read 1, both write 0), then show
  four ways to take stock and which ones are correct.
- **B, demo:** the burst test, naive vs the rest. Use 119 sold of 10 and 2,000
  sold of 1,000. Then the twist: plain Postgres kept up with Redis. Repo link
  in the first comment.
- **C, optional:** "Redis is more than a cache", covering the rate limiter and
  the queue.
- **Side note** for any of them: "my laptop's TCP queue gave out before my code
  did" (the 500-buyer refusals).
