# Try it yourself

Project 1 so far, from your browser: the flash sale, the rate limiter, the
background jobs and what happens when parts of the system go down. It takes
about 15 minutes.

## Start

You need Docker Desktop running and Node 22.

```bash
npm run setup          # first time only: .env files from their examples, npm install everywhere
npm run dev            # containers, 5 services, 2 workers and the frontend, in this terminal
```

Wait until these three lines have appeared. The order varies.

```
[inventory-worker] 👷 Inventory worker ready (checkout mode: postgres)
[orders-worker] 👷 Orders worker ready (reconcile every 30 s, ...)
[web] VITE ... ready
```

Then, in a second terminal:

```bash
npm run seed           # 1,000 products for the home page (once; skip if you've seeded before)
npm run sale -- 10     # a flash sale: one product, 10 units
```

Open **http://localhost:5173/flash-sale**.

## 1. Buy, and watch background jobs finish the order

1. Click **Buy now**.
   - The banner says *Order #… is placed. A background job is confirming it…*
   - Under **My orders**, the order reads **Confirmed** by the next refresh
     (the page polls every 2 s; the jobs took about 85 ms in testing).
   - The **Inbox** has *Order #… is confirmed*.
2. Check the stock panel: **9 left**, *In Postgres: 9 · waiting for their
   commit job: 0*.

**What happened:**
1. The orders service reserved the stock.
2. It saved the order as Pending and answered you straight away.
3. Two jobs ran in the background: `commit-stock` made the stock final, then
   `confirm-order` confirmed the order and wrote the email.

## 2. Act like a bot: the rate limiter

1. Click **Act like a bot: 10 tries at once**.
   - The banner reads *3 bought, 7 refused by the rate limiter*. It's 2 and 8
     if your step 1 purchase was less than 10 s ago.
   - **Buy now** turns into a countdown, *Try again in 10 s*.
   - Each shopper gets 3 tries at once, then one every 10 seconds.
2. Click **become a new shopper** at the bottom. You get a new `X-User-Id`
   and can buy straight away.
3. Now alternate **become a new shopper** and the bot button, quickly, about
   eight times in a row.
   - For the first five or so rounds each new shopper buys 3. Then it drops
     to 2, then 1, although every shopper is brand new.
   - That's the **per-IP** limit: 10 at once, then one a second. All your
     shoppers share your machine's IP.
   - This is the layer that stops bots that rotate their ids. In testing,
     the same rounds with the shopper id changing on every single request
     still got only 1–2 through per round.

Refused requests never reach the orders service: the gateway answers them by
itself. The details are in [the project 1 spec](projects/01-flash-sale.md),
phase 2.

## 3. Sell out

1. Keep buying as new shoppers until the stock hits 0. **Buy now** becomes
   **Sold out**.
2. The bot button now reports *10 sold out*: the store refused them all
   without overselling.

For a quick version, run `npm run sale -- 3` and click the bot button twice,
as two different shoppers.

## 4. Watch the job queues

Open **http://localhost:5003/admin/queues** (Bull Board).

- There are two queues:
  - **orders**: `confirm-order`, plus a `reconcile` job every 30 s, which
    shows under *Delayed*
  - **inventory**: `commit-stock`
- Each purchase left one job in each queue under *Completed*. Open a
  `commit-stock` job: its return value is
  `{ reservationId, status: "committed" }`.
- Bull Board can retry and delete jobs, so the gateway never exposes it. Try
  http://localhost:5000/orders/admin/queues: you get a 404.

## 5. Stop a worker in the middle of a sale

1. In the `npm run dev` terminal, press Ctrl+C. Then start everything except
   the inventory worker:

   ```bash
   npm run dev -- --without=inventory-worker
   ```

2. Buy a few times, as new shoppers.
   - Purchases still succeed instantly, but the orders stay **Confirming…**
     and *waiting for their commit job* climbs.
   - In Bull Board, **inventory** shows them as *Waiting*, and **orders** as
     *Waiting-children*.
3. In a second terminal, start the worker:

   ```bash
   npm run worker:inventory
   ```

   Within a second or two every order flips to **Confirmed**, the emails
   arrive and the waiting count drops to 0.

Nothing was lost: the jobs waited in Redis until a worker came back.

## 6. Take Redis away: the safety net

1. With everything running, in another terminal:

   ```bash
   docker compose stop redis
   ```

2. Buy as a new shopper. It still works:
   - the rate limiter fails open
   - Postgres checkout doesn't need Redis

   The order stays **Confirming…**, and the `npm run dev` terminal shows
   `Couldn't queue order … (the sweeper will)`.

   While Redis is down, also expect:
   - Redis connection errors from the workers in the log.
   - The home page's product grid hangs. That's a known issue, fixed in
     project 4.
3. Bring Redis back:

   ```bash
   docker compose start redis
   ```

   Within about a minute, the orders worker logs
   `🧹 Reconcile: {"flowsQueued": …}` and the orders flip to **Confirmed**.
   An order may stay Pending for 60 s before the sweeper steps in, and the
   sweeper runs every 30 s.

For a 5-second version, set `PENDING_GRACE_MS=5000` and
`RECONCILE_EVERY_MS=3000` in `services/orders/.env` and restart.

## 7. Switch checkout to Redis (optional)

1. In `services/products/.env`, set `CHECKOUT_MODE=redis`.
2. Restart `npm run dev`, then run `npm run sale -- 10`. The badge reads
   *checkout mode: redis*.
3. Buy.
   - **left** (Redis) drops the instant you click.
   - **In Postgres** catches up when `commit-stock` runs. That takes
     milliseconds, so you'll rarely catch the gap.
   - Combine this with step 5 (no inventory worker) and the gap stays open
     until you start the worker.
4. Set it back to `postgres` when you're done.

## Reset and stop

- `npm run sale -- 10` starts the sale over at any time: stock, the sale's
  orders, carts and rate limits.
- `npm run sale:report` prints what was sold, orders by status, and any
  reservations still open.
- Ctrl+C in the `npm run dev` terminal stops everything. The containers keep
  running, so the next start is quick.

## If something's off

| What you see | What to do |
|---|---|
| *No flash sale is running* | `npm run sale -- 10` |
| *Lost contact with the store* | `npm run dev` isn't running, or a service crashed: check its lines in that terminal |
| *Try again in N s* | The rate limiter. Wait, or become a new shopper |
| Orders stuck on **Confirming…** | Is the inventory worker running? (`npm run worker:inventory`) If not, the sweeper also steps in after a minute |
| The products service exits at startup | RabbitMQ wasn't ready yet. `npm run dev` waits for the containers, so start it again |
| Port 5000–5004 or 5173 already in use | Something from an earlier run is still alive: close old terminals, or restart Docker Desktop |
