# Pipeline: projects 2 to 5

These are starting points, not commitments. When a project becomes active:

1. Move its section to `docs/projects/0N-<slug>.md`.
2. Turn its scope into a phased checklist like project 1's, and add a Results table.
3. Update CLAUDE.md.

All of them assume project 1's phase 0 has landed: products, cart and orders
run on Postgres.

---

## 2. Search 44k real products (Elasticsearch)

**Hook:** "Last year I showed Meilisearch on 1,000 fake products and promised a
post on filtering. Here it is, on 44,000 real ones." Alternative: "Do you even
need Elasticsearch? I benchmarked Postgres, Meilisearch and Elasticsearch on
44,000 products."

- **Shows:** Postgres full-text search and `pg_trgm`, Elasticsearch mappings
  and analyzers, aggregations (facets), aliases for zero-downtime reindexing,
  relevance tuning, benchmarking.
- **Estimate:** about 1 to 1.5 weeks.

**The problem.** 1,000 generated products with random images make every demo
look fake. Search also takes two hops (Meilisearch → ids → a second database
query for filters), and the subcategory filter is broken.

**The data.** Kaggle's *Fashion Product Images* dataset (about 44k items). The
values in `Categories.jsx` (gender, master category, subcategory, colour,
usage) match its columns, so the sidebar keeps working. Check the dataset's
licence before publishing its images.

**Scope**

- An import script: CSV → Postgres with `COPY` → index.
- Elasticsearch 9 in `docker-compose.yml`: a single node, security off locally,
  1 GB heap. The installed client is `@elastic/elasticsearch` 9.2, so the
  server's major version has to match.
- An explicit mapping:
  - `text` fields with `keyword` subfields
  - an edge-ngram analyzer for autocomplete
  - synonyms (tee ↔ t-shirt)
  - fuzziness for typos
- One query returns the hits, applies the filters and returns facet counts
  (aggregations). That removes the second hop to the database.
- The existing `product_updates` consumer indexes products with the bulk API.
- Zero-downtime reindex: write `products_v{n}`, then swap the `products` alias.
- Frontend:
  - debounce plus `AbortController` on the search box
  - facet counts in the sidebar
  - an autocomplete dropdown
- Meilisearch keeps running for the benchmark.

**Fixes:** the consumer dropping fields, the subcategory filter and the
keystroke race. Project 1's phase 0 has already settled the id mismatch.

**Measure:** on the same 44k products, compare Postgres (`ILIKE`, then
full-text search with a GIN index and `pg_trgm` for typos), Meilisearch and
Elasticsearch on:

- p50/p95 latency per query type (prefix, typo, filtered)
- result quality on a fixed list of 20 queries

**Demo:** typing "snekers blak" returns results with facet counts. Then a
benchmark carousel.

---

## 3. Bulk catalog import (Supabase)

**Hook:** "A merchant uploads a 50,000-row product CSV. Do it in one request
and you get timeouts, a half-imported catalog, and no idea which rows failed."

- **Shows:** Postgres schema design, row-level security and multi-tenancy,
  Storage (S3-compatible), database webhooks, Edge Functions, pg_cron, Realtime.
- **Estimate:** about 1 week.

**The shape.** A standalone, merchant-side importer on Supabase. Develop it
against the local stack from the Supabase CLI and demo it on a free cloud
project. Feeding the store's catalog from it is a stretch goal for after
project 4 gives the store a public URL.

**Scope**

- Tables: `merchants`, `imports` (status, totals, counters), `import_chunks`,
  `products` (unique on `(merchant_id, sku)`) and `import_errors`.
- RLS so each merchant sees only their own rows. Every Shopify app needs the
  same tenant isolation.
- Upload: the browser gets a signed upload URL and sends the CSV straight to a
  Storage bucket. The file never passes through an API server.
- A database webhook on the new `storage.objects` row calls an Edge Function,
  which splits the file into chunks.
- A worker Edge Function processes chunks until it nears its time budget, then
  re-invokes itself. pg_cron sweeps every minute and restarts stalled imports.
- Rows are upserted (`insert … on conflict (merchant_id, sku) do update`), and
  bad rows go to `import_errors`.
- A Realtime progress bar on the `imports` row.
- An error-report CSV written back to Storage, with a signed download link.
- A nightly pg_cron cleanup of processed files and old chunks.
- Should: Supabase Queues (pgmq) instead of the chunk table, and retries for
  failed chunks.

**Measure:**

- rows per second and total time for 10k and 50k rows
- how it behaves with injected bad rows
- whether it fits the free tier

**Demo:** drop the CSV and watch the bar fill live, ending on "49,8xx imported,
1xx failed → download report".

**Alternative** if a consumer-facing demo is preferred: back-in-stock alerts. A
stock change from 0 to >0 fires a webhook that triggers an Edge Function email,
and pg_cron sends abandoned-cart reminders. Storage fits that one less
naturally.

---

## 4. Go to production (GCP, Cloudflare, Shopify webhooks)

**Hook:** a commenter on the old gateway post warned that async flows make
retries and observability harder: "It was right. Here's what I learned shipping
it." The alternative is the Shopify angle: Shopify waits 5 seconds for a 2xx,
retries 8 times over 4 hours, then removes the webhook subscription
(<https://shopify.dev/docs/apps/build/webhooks/troubleshoot>).

- **Shows:** Cloud Run, Pub/Sub, Compute Engine, Docker, the transactional
  outbox, idempotency, dead-letter queues, HMAC webhook verification,
  Cloudflare CDN and WAF, observability.
- **Estimate:** about 2 weeks.

**Scope**

- **Config:** every host comes from env vars. The Dockerfiles move to Node 22
  with production `start` scripts, and compose can run the whole stack.
- **Pub/Sub replaces RabbitMQ:**
  - topic `product-events`, with a push subscription to the search indexer on Cloud Run
  - a dead-letter topic and retries with backoff
  - idempotency keys in Redis, because Pub/Sub delivers at least once
  - ordering keys per product
- **Transactional outbox in products:** the product row and its event row are
  written in one Postgres transaction, and a relay publishes the event.
- **Webhook receiver on Cloud Run:** it verifies `X-Shopify-Hmac-Sha256`,
  replies 200 immediately and publishes to Pub/Sub. A free Shopify Partner
  development store is the real event source (`products/update`,
  `inventory_levels/update`).
- **Deploy:**
  - stateless services on Cloud Run, scaling to zero
  - Meilisearch or Elasticsearch, plus Redis, on one small Compute Engine VM with Docker
  - managed Postgres: Supabase's free tier keeps the stack consistent with
    project 3, and Cloud SQL is the GCP-native option
  - "what runs where, and why" is a post of its own
- **Cloudflare in front.** This needs a domain (a cheap one is fine).
  - edge caching for listings (`s-maxage`, `stale-while-revalidate`)
  - a WAF rate-limit rule in front of the Redis limiter
  - Cloudflare has a Kathmandu data center
    (<https://blog.cloudflare.com/kathmandu/>), so "server in Iowa, users in
    Kathmandu" is a real before/after
- **Bot defense beyond rate limiting:** project 1 measured that bots rotating
  `X-User-Id` from 5 IPs still took 60 of 100 units. Options:
  - Cloudflare Turnstile on checkout
  - Cloudflare's bot signals
  - a waiting room that randomizes everyone who arrives in the first seconds
- **Resilience fixes:**
  - give the products service's Redis client the gateway's fail-fast
    settings (no offline queue, a command timeout)
  - ack messages only after success
  - a breaker fallback that works
  - one breaker per downstream service, with an `errorFilter` so 4xx answers
    (404, 409 sold out) don't count as failures
- **Load tests from inside Docker:** once every service runs in compose, k6
  can share their network. On Windows the `host.docker.internal` hop times out
  connections under a burst (project 1 spec, "Harness limits found").
- **Observability:**
  - a correlation id passed from the gateway through Pub/Sub attributes
  - structured logs
  - a Cloud Monitoring dashboard (backlog, instances, DLQ)
- **Cost guard:** the GCP free-trial credit, a budget alert, scale to zero and
  the smallest VM that works.

**Measure:**

- a burst of 10k signed webhooks: time to drain, peak instances, DLQ count and
  duplicates suppressed
- latency from Kathmandu to the origin vs to the Cloudflare cache

**Demo:** the monitoring graphs during the burst, plus a live URL people can
click.

---

## 5. AI shopping assistant (LLM + LangSmith)

**Hook:** "I searched my store for 'outfit for a beach wedding under $100' and
got 0 results. Keyword search can't understand intent."

- **Shows:** LLM integration, tool calling, hybrid (keyword + vector) search,
  guardrails, evals, observability, cost control.
- **Depends on:** project 2's index, and project 1's Redis for caching.
- **Estimate:** about 1.5 weeks.

**Scope**

- A new `assistant` service with a streaming chat endpoint, plus a chat widget
  in the frontend.
- Tool calling: `search_products(query, filters)`, `get_product(id)` and
  `add_to_cart(userId, productId, quantity)`. The model turns a sentence into
  structured filters (gender, usage, colour, price).
- Guardrails:
  - recommend only products the tools returned
  - product cards render price and stock from data, never from model text
  - stay on shopping topics
- LangSmith:
  - trace every conversation (tool calls, latency, tokens, cost)
  - an eval set of 30–50 realistic queries with expected filters, scored
    before and after each prompt change
- Should:
  - embeddings in an Elasticsearch `dense_vector` field (or pgvector), so
    vague requests ("something cozy for monsoon") get hybrid search
  - cache embeddings in Redis
  - a cheaper model for intent parsing and a stronger one for the answer
  - ship the widget as a theme app extension on the Shopify dev store
- The provider is decided at kickoff. LangSmith traces any of them.

**Measure:**

- eval accuracy before and after
- time to first token (p50/p95)
- cost per conversation

**Demo:** a chat video, a LangSmith trace screenshot and the eval score change.
If LangSmith catches the assistant recommending a product that doesn't exist,
that's the best post of the series.
