# CLAUDE.md

Context for Claude Code sessions in this repo. Keep it current: when a project
ships or the architecture changes, update this file in the same change.

**Current focus: Project 1, Flash Sale Mode (Redis)**, starting with phase 0:
moving products, cart and orders from MongoDB to Postgres. The spec and
checklist are in [docs/projects/01-flash-sale.md](docs/projects/01-flash-sale.md).
Read the spec before working on any project task.

## What this repo is

A small microservices e-commerce store that Bishow Lamichhane is growing in
public for a LinkedIn series. Bishow is a Shopify App Developer at Cartmade.
The series shows the backend skills behind that job (Postgres, Redis,
Elasticsearch, Supabase, GCP, Cloudflare, LLMs) through mini-projects built on
this store. Each project fixes a real problem in the store and becomes two
posts: a design post while building, then a demo post with measured numbers.

This repo is a clean restart of Bishow's older private repo
(`D:/Internship/ecom-microservices`). It has the same code, without that repo's
git history, `.env` files or `node_modules`. Treat the old repo as an archive and
don't copy files from it.

## Ground rules

- **No employer IP.** Never open, copy or paraphrase code, data, client names
  or internal metrics from Bishow's work projects (the other folders under
  `D:/Internship`). Keep the domain fashion retail and use textbook patterns.
- **No secrets in git.** Real config lives in each service's `.env`
  (gitignored). When you add a variable, also add it to that folder's
  `.env.example` with a safe local default. Never put real credentials or
  hosted connection strings in code, compose files, docs or posts. Local-only
  defaults, like the compose Postgres user, are fine.
- **Real numbers only.** Any number that might appear in a post must come from
  a run in this repo. Record it in the project spec's *Results* table with the
  command, data size and machine. Never invent or round up results, and never
  tune a benchmark so the new approach wins. A laptop benchmark shows relative
  differences, not production capacity, and posts should say so.
- **Bishow must be able to explain every line in an interview.** Work in small,
  reviewable steps and explain why behind each design decision. Prefer plain
  code over clever abstractions. Ask before adding a dependency, tool or
  service. Each spec lists the ones already planned.
- **Git:** commit or push only when asked. Use one branch per project
  (`p1-flash-sale`, `p2-search`, …).

## Architecture (at the start of project 1)

```
frontend (Vite + React 19, :5173): calls http://localhost:5000 directly
   │
gateway (:5000): http-proxy-middleware, strips the prefix
   │             /products  /cart  /orders  /search
   ├── products (:5001): Mongo product_service
   │      ├── Redis: listing cache products:{skip}:{limit}, TTL 60s
   │      └── RabbitMQ: publishes add/update/delete to queue product_updates
   ├── cart (:5002): Mongo cart_service; reads products through an opossum breaker
   ├── orders (:5003): Mongo orders_service; calls cart (breaker) and products (plain axios)
   └── search (:5004): consumes product_updates → Meilisearch index "products"
```

Every service has the same layout. `index.js` loads `.env`, connects to Mongo,
listens and connects to the broker. `app.js` builds the Express app and mounts
the router at `/`. Requests flow `routes/` → `controllers/` → `models/`, and
`utils/` holds `ApiError`, `ApiResponse`, `asyncHandler`, `circuitBreaker` and
similar helpers.

Phase 0 of project 1 changes this. products, cart and orders move from Mongoose
to `pg` with plain SQL, with one database per service (`product_service`,
`cart_service`, `orders_service`). Ids switch from `_id` to `id` in every
service and in the frontend, and search drops its unused Mongo connection.
Update the diagram when that lands.

## Running locally

```bash
docker compose up -d     # postgres (host port 5433), mongo (until phase 0 lands),
                         # redis, rabbitmq (UI :15672), meilisearch (:7700)
for d in gateway services/*; do cp -n "$d/.env.example" "$d/.env"; done

# one terminal each for gateway/ and services/{products,cart,orders,search}:
npm install && npm run dev

cd frontend && npm install && npm run dev       # http://localhost:5173

# seed 1,000 generated products (needs the gateway and products running;
# search indexes them from the queue)
cd frontend && node src/utils/addProduct.js
```

Start the containers before the services. products crashes if RabbitMQ is
down, because `connectRabbitMQ()` is neither awaited nor retried. search never
retries its consumer. There are no tests yet. Frontend lint is `npm run lint`.

Postgres listens on host port **5433**, so it doesn't clash with another local
Postgres on 5432. `docker/postgres/init.sql` creates the databases only when
the volume is first created. `docker compose down -v` deletes every volume,
data included.

## Conventions and gotchas

- ESM everywhere, Express 5, and Mongoose 8 until phase 0. Node 22 runs
  locally. The Dockerfiles are dev-only (`node:18`, nodemon), and the gateway
  and search ones are commented out.
- Controllers call `new ApiResponse(status, "text", payload)`, but the
  constructor's signature is `(statusCode, data, message)`. So the payload
  lands in `.message`, and the frontend reads `res.data.message`. Don't fix
  this in passing: changing it breaks every client call.
- To return an error, throw `new ApiError(status, msg)` inside `asyncHandler`.
  It replies `{ message, success: false }`.
- `utils/circuitBreaker.js` is copy-pasted into each service. Each process has
  one opossum breaker, shared by every downstream URL.
- Redis, RabbitMQ and Meilisearch hosts are hardcoded to `localhost` in
  `redisClient.js`, both `messageQueue.js`, `meiliClient.js` and the `/sync` URL
  in `search.controller.js`. That works on the host. Moving them to env vars is
  part of project 4.
- Don't add `express.json()` to the gateway. It would consume request bodies
  before the proxy forwards them.

## Known bugs: each belongs to a project

Fix a bug inside the project that owns it, not in passing. The before/after is
post material.

| Bug | Where | Project |
|---|---|---|
| Stock never goes down: `placeOrder` PATCHes `stock`, but `updateProduct` only sets `image`. Read-check-write across services is also a race | `orders.controller.js` → `product.controller.js` | 1 |
| Every shopper shares one cart (`Cart.findOne()` with no user filter). Orders drop the user (`userId` in code vs `user_id` in the schema) | `cart.controller.js`, `orders.controller.js` | 1 |
| `KEYS products:*` blocks Redis, and `removeAllProducts` runs `flushall` | `utils/cacheClear.js`, `product.controller.js` | 1 |
| Search docs carry `id` while the frontend reads `_id`, and `/sync` pushes `_id` docs into an index keyed by `id` (phase 0's switch to `id` settles both). The consumer also drops image, colour and gender | `search/utils/messageQueue.js`, `Header.jsx`, `search.controller.js` | 2 |
| The subcategory filter never applies (the frontend sends `subcategory`, the backend reads `subCategory`, and the schema field is `subcategory`) | `Categories.jsx`, `product.controller.js` | 2 |
| Search fires on every keystroke with no debounce or cancel, so stale results can win | `Header.jsx` | 2 |
| Dual write: the product is saved, then publishing throws if RabbitMQ is down, so it's never indexed | `product.controller.js` `addProduct` | 4 |
| The consumer acks failed messages, and published messages aren't persistent | both `utils/messageQueue.js` | 4 |
| Cart's breaker fallback crashes because the fallback object has no `.message` | `cart.controller.js` `getCartItems` | 4 |

## The series

| # | Project | Status | Spec |
|---|---|---|---|
| 1 | Flash Sale Mode (Redis) | **active** | [01-flash-sale.md](docs/projects/01-flash-sale.md) |
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
