# Project 1: Flash Sale Mode (Redis)

- **Status:** active, phase 0
- **Branch:** `p1-flash-sale`
- **Estimate:** about 2 weeks part-time including the move to Postgres (about
  1.5 weeks for the "must" phases)
- **Shows:** Postgres transactions and row locks, Redis beyond caching (Lua for
  atomicity, TTLs, sorted sets), rate limiting, BullMQ job queues, cache
  invalidation done right, concurrency bugs, load testing with k6.

## The story

> "500 people hit Buy on the last 10 pairs of sneakers in the same second. My store sold [N]."

A flash sale is when a store's backend gets tested: one hot product, a few
units, hundreds of buyers at once. Today this store fails that test:

1. **Stock never goes down.** `placeOrder` PATCHes the new stock to
   `/update-product`, but `updateProduct` only sets `image`.
2. **Read-check-write is a race.** Even with the write fixed, two requests can
   both read `stock: 1`, both pass the check and both write `0`. Two units get sold.
3. **Every shopper shares one cart**, and orders ignore the user.
4. **There's no rate limiting.** One script can hammer checkout.
5. **Cache invalidation blocks Redis** (`KEYS products:*`). `removeAllProducts`
   also runs `flushall`, which would wipe queues and limiter state once they
   share Redis.

The honest arc for the posts: the *minimal* correct fix is one conditional
`UPDATE` in Postgres. Redis has to earn its place with measured results: speed
under contention, all-or-nothing multi-item reservations, and expiry. If
Postgres does just as well at this scale, the post says so.

## Design

### Phase 0: MongoDB → Postgres

Inventory is a transactions-and-locking problem, and Postgres is the database
behind Bishow's day-to-day stack (Supabase). The store is small, so the move is
cheapest now.

- products, cart and orders use `pg` with plain, parameterized SQL, with no
  ORM. Every query stays visible in the code and in the posts.
- Each service gets its own database, created by `docker/postgres/init.sql`.
  Each service creates its own tables on boot (`CREATE TABLE IF NOT EXISTS`)
  until we need real migrations.
- The tables mirror the Mongoose models:
  - `products`, with the same indexes
  - `carts` and `cart_items`
  - `orders` and `order_items`
- Money is `numeric(10,2)`. node-postgres returns `numeric` as a string, so
  convert it before it reaches JSON.
- `products.stock` gets `CHECK (stock >= 0)` as a last line of defence. Show
  which modes it actually catches: it stops `stock - qty` from going negative,
  but not naive mode writing a value it computed from a stale read.
- Behaviour stays identical, known bugs included. Each bug gets fixed in its
  own phase, so it has a before/after.
- Ids switch from `_id` to `id` everywhere, frontend included.

### Three checkout modes

All three sit behind one products endpoint, `POST /inventory/reserve`, chosen
by `CHECKOUT_MODE` in `services/products/.env`. Orders always calls the same
endpoint, so one load test compares the modes fairly.

| Mode | How stock is taken | Expect |
|---|---|---|
| `naive` | `SELECT stock`, check in code, then `UPDATE … SET stock = <computed>`. The write bug is fixed, so the race is the only flaw | oversells under load |
| `postgres` | `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock` | correct; every buyer queues on one row lock |
| `redis` | a Lua script checks and decrements `stock:{productId}` for every item in one atomic step | correct; sold-out requests are rejected in memory |

Could: a fourth variant using `SELECT … FOR UPDATE` inside a transaction, to
compare an explicit row lock with the conditional update.

How the redis mode works:

- Sale stock lives in `stock:{productId}` and is loaded from Postgres when a
  sale starts. During the sale, the product page reads remaining stock from Redis.
- `reserve.lua` is all-or-nothing across a cart's items. If anything fails
  after the reservation, `release.lua` returns the units.
- Postgres catches up through a commit step: a guarded `UPDATE`, idempotent by
  order id. It runs synchronously in phase 1 and becomes a job in phase 3.
- Should: pending-payment reservations. Store `resv:{orderId}` plus a sorted set
  `resv:expiry`, and have a sweeper release unpaid orders after 10 minutes.
- Redis runs with AOF on (see `docker-compose.yml`). BullMQ needs
  `maxmemory-policy noeviction`. If memory is ever capped for the cache, the
  queues move to their own Redis.

### What goes around it

- **Buy now:** `POST /orders/buy-now { userId, productId, quantity }` is the
  flash-sale path and skips the cart.
- **Rate limiter in the gateway:** a sliding window in a Redis sorted set on
  `/orders/*`. It's keyed by `X-User-Id`, falling back to IP, because all k6
  traffic comes from one IP. It replies 429 with `Retry-After` and
  `X-RateLimit-*` headers.
- **BullMQ** handles after-order work: `commit-stock`, `send-confirmation`
  (a simulated email) and a repeatable `release-expired`. Jobs retry with
  exponential backoff, and Bull Board at `/admin/queues` shows them for the demo.
- **Cache fixes:**
  - versioned listing keys (`INCR products:version` instead of `KEYS`)
  - no `flushall`
  - lock-based stampede protection
  - a product-detail cache for the cart and orders hot path
- **Demo page** `/flash-sale`: one product, live remaining stock, and a Buy now button.

### Planned new dependencies (approve when reviewing this spec)

- `pg` in products, cart and orders (phase 0; it replaces `mongoose`)
- `ioredis` in the gateway, for the limiter
- `bullmq`, `@bull-board/api` and `@bull-board/express` in products
- k6 through Docker (`grafana/k6`, targeting `http://host.docker.internal:5000`), so there's nothing to install

## Checklist

### Phase 0: Postgres, harness and baseline (must)
- [x] Postgres in `docker-compose.yml` (host port 5433), one database per service
- [ ] Port products, cart and orders from Mongoose to `pg`, behaviour unchanged
- [ ] Switch ids from `_id` to `id` in the services, the search consumer and the frontend
- [ ] Drop search's unused Mongo connection; remove Mongo from compose and `MONGODB_URI` from the env files
- [ ] Smoke test: compose comes up, every service boots from `.env.example`, the seed works, the UI behaves as before
- [ ] `scripts/reset-sale.js`: sets one product's stock to S, clears its orders and the Redis sale keys
- [ ] `loadtest/flash-sale.js` (k6): N users buy at the same moment; it counts 2xx, 409, 429 and 5xx responses, oversold units, and p50/p95
- [ ] Baseline run → Results

### Phase 1: correct under concurrency (must)
- [ ] `POST /orders/buy-now`, plus `POST /inventory/reserve` and `/inventory/release` in products
- [ ] `naive` mode (stock write fixed)
- [ ] `postgres` mode
- [ ] `redis` mode: load sale stock, `reserve.lua`, `release.lua`, commit to Postgres after the order is created
- [ ] Orders store the user
- [ ] Per-user carts, so cart checkout uses the same reserve path. Decide at that point between a `user_id` on the Postgres cart and a Redis hash `cart:{userId}`
- [ ] Load-test all three modes → Results

### Phase 2: rate limiting (must)
- [ ] Sliding-window limiter in the gateway, with 429 and headers
- [ ] Test: one abusive user gets limited, and normal users don't notice

### Phase 3: async work (should)
- [ ] BullMQ queue and worker for `commit-stock`, `send-confirmation` and `release-expired`
- [ ] Bull Board for the demo
- [ ] Kill the worker mid-sale, restart it, and show that nothing is lost

### Phase 4: read path (should)
- [ ] Versioned cache keys; remove `KEYS` and `flushall`
- [ ] Stampede protection and the product-detail cache
- [ ] k6 read test: p95 and hit ratio (`INFO stats`) with the cache on vs off → Results

### Phase 5: demo and posts (must)
- [ ] `/flash-sale` page with live stock
- [ ] Record the split-screen demo (naive vs redis)
- [ ] Drafts of post A (design) and post B (demo) in `posts/`

## Results

Only numbers from this table go into posts. Everything runs locally.

**Machine:** Windows 11, Docker Desktop 29.5, Node 22.22. Fill in CPU and RAM on the first run.

| Date | Mode | Stock | Users | Orders | Oversold | p50 | p95 | 409 / 429 / 5xx | Command / notes |
|---|---|---|---|---|---|---|---|---|---|

## Posts

- **Optional, early:** why the store moved from MongoDB to Postgres before the
  flash sale. The reason is fit for this workload (multi-row transactions,
  row locks), not "Mongo bad".
- **A, design:** draw the race (two requests read 1, both write 0) and show three ways to fix it.
- **B, demo:** the split-screen load test, the results table and one takeaway. Repo link in the first comment.
- **C, optional:** "Redis is more than a cache", covering the rate limiter and the queue.
